"""TRELLIS Atelier — lightweight Windows app (native WebView2 + local HTTP UI).

The UI is separate from TRELLIS. The actual neural network is only invoked from
worker.py using the user's pre-existing TRELLIS Python environment.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_TITLE = 'Средство 3D'
WORKER_EVENT = 'ATELIER_EVENT:'
STAGES = ['loading', 'preparing', 'generating', 'exporting']
STAGE_NAMES = {
    'loading': 'Загрузка нейросети',
    'preparing': 'Подготовка изображения',
    'generating': 'Генерация 3D',
    'exporting': 'Экспорт модели',
}
ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
HOME = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'TRELLIS-Atelier'
UPLOADS = HOME / 'uploads'
SETTINGS_FILE = HOME / 'settings.json'
HISTORY_FILE = HOME / 'history.json'
MAX_UPLOAD = 24 * 1024 * 1024
for folder in (HOME, UPLOADS):
    folder.mkdir(parents=True, exist_ok=True)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def atomic_json(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def default_settings():
    return {
        'trellis_path': r'D:\AI\TRELLIS',
        'output_path': str(HOME / 'generations'),
        'ss_steps': 12,
        'slat_steps': 12,
        'ss_guidance': 7.5,
        'slat_guidance': 3.0,
        'seed': 0,
        'random_seed': True,
        'texture_size': 512,
        'simplify': 0.95,
        'export_glb': True,
        'export_ply': False,
    }


def sanitize_settings(payload, existing=None):
    current = dict(existing or default_settings())
    if not isinstance(payload, dict):
        raise ValueError('Неверный формат настроек')
    for key in ('trellis_path', 'output_path'):
        if key in payload:
            value = str(payload[key]).strip().strip('"')
            if len(value) > 1024:
                raise ValueError('Слишком длинный путь')
            current[key] = value
    for key, low, high in (
        ('ss_steps', 1, 50), ('slat_steps', 1, 50),
        ('texture_size', 512, 2048), ('seed', 0, 2147483647),
    ):
        if key in payload:
            value = int(payload[key])
            current[key] = min(max(value, low), high)
    if current['texture_size'] not in (512, 1024, 2048):
        current['texture_size'] = 512
    for key, low, high in (
        ('ss_guidance', 0., 10.), ('slat_guidance', 0., 10.),
        ('simplify', 0.9, 0.98),
    ):
        if key in payload:
            current[key] = min(max(float(payload[key]), low), high)
    for key in ('random_seed', 'export_glb', 'export_ply'):
        if key in payload:
            if not isinstance(payload[key], bool):
                raise ValueError(f'Ожидался флаг {key}')
            current[key] = payload[key]
    if not current['export_glb'] and not current['export_ply']:
        raise ValueError('Выберите хотя бы один формат экспорта')
    return current


def trellis_interpreter(folder):
    code = Path(folder).expanduser().resolve() / 'code'
    candidates = [
        code / 'venv' / 'Scripts' / 'python.exe',
        code / '.venv' / 'Scripts' / 'python.exe',
        code / 'venv' / 'bin' / 'python',
        code / '.venv' / 'bin' / 'python',
    ]
    for python in candidates:
        if python.exists() and (code / 'gradio_main.py').exists():
            return str(python), str(code)
    raise FileNotFoundError(
        'Не найден TRELLIS. Проверьте путь к папке, в которой находится code\\gradio_main.py '
        'и code\\venv\\Scripts\\python.exe.'
    )


class JobManager:
    def __init__(self):
        self.lock = threading.RLock()
        self.settings = sanitize_settings(read_json(SETTINGS_FILE, {}), default_settings())
        self.history = read_json(HISTORY_FILE, [])
        if not isinstance(self.history, list):
            self.history = []
        self.current = None
        self.proc = None
        self.cancel_requested = False

    def settings_get(self):
        with self.lock:
            return dict(self.settings)

    def settings_set(self, payload):
        with self.lock:
            self.settings = sanitize_settings(payload, self.settings)
            atomic_json(SETTINGS_FILE, self.settings)
            return dict(self.settings)

    def history_get(self):
        with self.lock:
            return list(self.history)[:60]

    def _eta_locked(self, job):
        if job['status'] != 'running' or job['stage'] not in STAGES:
            return None
        samples = [x.get('durations') for x in self.history
                   if x.get('status') == 'done' and isinstance(x.get('durations'), dict)]
        if not samples:
            return None
        current_index = STAGES.index(job['stage'])
        predicted = 0.0
        for i, stage in enumerate(STAGES[current_index:], start=current_index):
            vals = [float(s[stage]) for s in samples[:8] if stage in s and isinstance(s[stage], (int, float))]
            if not vals:
                return None
            mean = sum(vals) / len(vals)
            if i == current_index:
                mean -= time.time() - job['stage_started_at']
            predicted += max(0, mean)
        return round(predicted)

    def status_get(self):
        with self.lock:
            if not self.current:
                return None
            job = dict(self.current)
            started = job['started_at']
            job['elapsed_sec'] = round((job.get('finished_at') or time.time()) - started)
            job['eta_sec'] = self._eta_locked(job)
            job['stage_number'] = STAGES.index(job['stage']) + 1 if job['stage'] in STAGES else (4 if job['status'] == 'done' else 0)
            job.pop('stage_started_at', None)
            job.pop('durations', None)
            return job

    def start(self, image_id, opts):
        with self.lock:
            if self.current and self.current['status'] == 'running':
                raise ValueError('Дождитесь завершения текущей задачи или отмените её')
            input_file = UPLOADS / f'{image_id}.png'
            if not re.fullmatch(r'[a-f0-9]{24}', str(image_id)) or not input_file.is_file():
                raise ValueError('Сначала загрузите изображение')
            settings = sanitize_settings(opts, self.settings)
            exe, code_dir = trellis_interpreter(settings['trellis_path'])
            output_root = Path(settings['output_path']).expanduser().resolve()
            output_root.mkdir(parents=True, exist_ok=True)
            job_id = dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)
            job_dir = output_root / job_id
            job_dir.mkdir(parents=True, exist_ok=False)
            shutil.copy2(input_file, job_dir / 'input.png')
            if settings['random_seed']:
                settings['seed'] = secrets.randbelow(2147483647)
            now = time.time()
            self.current = {
                'id': job_id,
                'status': 'running',
                'stage': 'loading',
                'message': 'Запускаем TRELLIS',
                'started_at': now,
                'stage_started_at': now,
                'finished_at': None,
                'output_dir': str(job_dir),
                'seed': settings['seed'],
                'files': {},
                'logs': [],
                'durations': {},
                'error': None,
            }
            self.cancel_requested = False
            worker = ROOT / 'worker.py'
            cmd = [exe, '-u', str(worker), '--code-dir', code_dir,
                   '--image', str(job_dir / 'input.png'), '--output', str(job_dir),
                   '--job-id', job_id, '--settings', json.dumps(settings, ensure_ascii=False)]
            thread = threading.Thread(target=self._run_worker, args=(cmd, job_id), daemon=True)
            thread.start()
            return {'id': job_id, 'seed': settings['seed']}

    def _run_worker(self, cmd, job_id):
        env = dict(os.environ)
        env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
        env['no_proxy'] = env['NO_PROXY']
        env['PYTHONUNBUFFERED'] = '1'
        startupinfo = None
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        final_event = None
        returncode = -1
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding='utf-8', errors='replace',
                                    bufsize=1, env=env, creationflags=flags, startupinfo=startupinfo)
            with self.lock:
                self.proc = proc
                if self.cancel_requested:
                    proc.kill()
            for line in proc.stdout:
                line = line.rstrip('\r\n')
                if line.startswith(WORKER_EVENT):
                    try:
                        event = json.loads(line[len(WORKER_EVENT):])
                    except ValueError:
                        continue
                    stage = event.get('stage')
                    with self.lock:
                        if self.current and self.current['id'] == job_id:
                            job = self.current
                            if stage in STAGES and stage != job['stage']:
                                previous = job['stage']
                                if previous in STAGES:
                                    job['durations'][previous] = time.time() - job['stage_started_at']
                                job['stage_started_at'] = time.time()
                                job['stage'] = stage
                            job['message'] = str(event.get('message') or job['message'])[:250]
                            if stage == 'error':
                                job['error'] = str(event.get('traceback') or event.get('message') or 'Ошибка')[-3500:]
                            elif stage == 'complete':
                                final_event = event
                else:
                    with self.lock:
                        if self.current and self.current['id'] == job_id:
                            self.current['logs'].append(line[-500:])
                            self.current['logs'] = self.current['logs'][-70:]
            proc.stdout.close()
            returncode = proc.wait()
        except Exception as exc:
            with self.lock:
                if self.current and self.current['id'] == job_id:
                    self.current['error'] = traceback.format_exc()[-3500:]
        finally:
            with self.lock:
                self.proc = None
                if not self.current or self.current['id'] != job_id:
                    return
                job = self.current
                if job['stage'] in STAGES:
                    job['durations'][job['stage']] = time.time() - job['stage_started_at']
                if self.cancel_requested:
                    job['status'] = 'cancelled'
                    job['message'] = 'Генерация остановлена'
                elif returncode == 0 and final_event:
                    job['status'] = 'done'
                    job['stage'] = 'complete'
                    job['files'] = final_event.get('files', {})
                    job['message'] = 'Модель успешно создана'
                else:
                    job['status'] = 'error'
                    job['message'] = 'TRELLIS завершился с ошибкой'
                    if not job['error']:
                        job['error'] = '\n'.join(job['logs'][-20:]) or 'Неизвестная ошибка'
                job['finished_at'] = time.time()
                saved = {k: v for k, v in job.items()
                         if k not in ('logs', 'stage_started_at')}
                self.history.insert(0, saved)
                self.history = self.history[:60]
                atomic_json(HISTORY_FILE, self.history)

    def cancel(self):
        with self.lock:
            if not self.current or self.current['status'] != 'running':
                raise ValueError('Нет активной генерации')
            self.cancel_requested = True
            proc = self.proc
        if proc and proc.poll() is None:
            proc.kill()
        return {'ok': True}

    def job_by_id(self, job_id):
        with self.lock:
            for item in [self.current, *self.history]:
                if item and item.get('id') == job_id:
                    return dict(item)
        return None

    def open_folder(self, job_id):
        item = self.job_by_id(job_id)
        if not item:
            raise ValueError('Задача не найдена')
        folder = Path(item['output_dir'])
        if not folder.is_dir():
            raise ValueError('Папка с результатами не найдена')
        if os.name == 'nt':
            os.startfile(str(folder))
        else:
            subprocess.Popen(['xdg-open', str(folder)])


manager = JobManager()


def gpu_status():
    """Read-only information from NVIDIA utility, never fabricate VRAM values."""
    try:
        done = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,memory.total,memory.used',
             '--format=csv,noheader,nounits'], capture_output=True, text=True,
            timeout=3, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        )
        name, total, used = (x.strip() for x in done.stdout.splitlines()[0].split(',')[:3])
        return {'name': name[:100], 'total_mib': int(total), 'used_mib': int(used)}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return {'name': None, 'total_mib': None, 'used_mib': None}


class Handler(BaseHTTPRequestHandler):
    server_version = 'TRELLIS-Atelier/1.0'

    def log_message(self, *args):
        return

    def json_response(self, result, code=200):
        data = json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_file(self, path, content_type=None):
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        mime = content_type or mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        start, end, partial = 0, size - 1, False
        range_header = self.headers.get('Range', '')
        if range_header.startswith('bytes='):
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header[6:].strip())
            if match and size:
                lo, hi = match.groups()
                if lo or hi:
                    if lo:
                        start = int(lo)
                        end = min(int(hi), size - 1) if hi else size - 1
                    else:
                        start = max(0, size - int(hi))
                    if start >= size or start > end:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.end_headers()
                        return
                    partial = True
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type', mime)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(max(0, end - start + 1)))
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        if path.suffix in ('.glb', '.ply'):
            self.send_header('Content-Disposition', f'attachment; filename="{path.name}"')
        self.end_headers()
        with path.open('rb') as fh:
            fh.seek(start)
            remaining = max(0, end - start + 1)
            while remaining > 0:
                chunk = fh.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionError, BrokenPipeError):
                    break
                remaining -= len(chunk)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path).path
        if url == '/api/settings':
            return self.json_response(manager.settings_get())
        if url == '/api/system':
            return self.json_response(gpu_status())
        if url == '/api/status':
            return self.json_response(manager.status_get())
        if url == '/api/history':
            return self.json_response(manager.history_get())
        if url.startswith('/files/'):
            parts = url.split('/')
            if len(parts) != 4 or not re.fullmatch(r'[0-9]{8}-[0-9]{6}-[a-f0-9]{6}', parts[2]):
                return self.send_error(404)
            name = parts[3]
            if name not in ('preview.mp4', 'model.glb', 'model.ply', 'input.png'):
                return self.send_error(404)
            job = manager.job_by_id(parts[2])
            if not job:
                return self.send_error(404)
            return self.serve_file(Path(job['output_dir']) / name)
        static_map = {
            '/': ('index.html', 'text/html; charset=utf-8'),
            '/app.css': ('app.css', 'text/css; charset=utf-8'),
            '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
            '/model-viewer.min.js': ('model-viewer.min.js', 'application/javascript; charset=utf-8'),
            '/mountain-amber.svg': ('mountain-amber.svg','image/svg+xml'),
            '/mountain-blue.svg': ('mountain-blue.svg','image/svg+xml'),
        }
        if url == '/api/health':
            return self.json_response({'ok': True, 'product': 'Sredstvo3D'})
        if url in static_map:
            filename, mime = static_map[url]
            return self.serve_file(ROOT / 'docs' / filename, mime)
        self.send_error(404)

    def read_json_request(self):
        n = int(self.headers.get('Content-Length', '0'))
        if n < 1 or n > 65536:
            raise ValueError('Некорректный размер запроса')
        return json.loads(self.rfile.read(n).decode('utf-8'))

    def do_POST(self):
        # Block cross-site form submissions to local service (loopback-only API).
        origin = self.headers.get('Origin')
        if origin:
            parsed = urllib.parse.urlparse(origin)
            if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.port != 7867:
                return self.json_response({'error': 'Запрос отклонён: неверный Origin'}, 403)
        url = urllib.parse.urlparse(self.path).path
        try:
            if url == '/api/upload':
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n <= MAX_UPLOAD:
                    raise ValueError('Размер изображения не должен превышать 24 МБ')
                image = self.rfile.read(n)
                is_png = image.startswith(b'\x89PNG\r\n\x1a\n')
                is_jpg = image.startswith(b'\xff\xd8\xff')
                is_webp = image.startswith(b'RIFF') and image[8:12] == b'WEBP'
                if not (is_png or is_jpg or is_webp):
                    raise ValueError('Загрузите PNG, JPG или WebP')
                # The worker opens the image with Pillow, so the suffix here is informational.
                image_id = secrets.token_hex(12)
                (UPLOADS / f'{image_id}.png').write_bytes(image)
                return self.json_response({'image_id': image_id})
            data = self.read_json_request()
            if url == '/api/settings':
                return self.json_response(manager.settings_set(data))
            if url == '/api/start':
                return self.json_response(manager.start(data.get('image_id'), data.get('settings', {})))
            if url == '/api/cancel':
                return self.json_response(manager.cancel())
            if url == '/api/open-folder':
                manager.open_folder(str(data.get('id', '')))
                return self.json_response({'ok': True})
            self.send_error(404)
        except (OSError, ValueError, TypeError, KeyError) as e:
            self.json_response({'error': str(e)}, 400)


class NativeApi:
    def pick_folder(self):
        try:
            # Only called by a direct button click in the desktop WebView.
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            result = filedialog.askdirectory(title='Выберите папку')
            root.destroy()
            return result or ''
        except Exception:
            return ''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', action='store_true', help='Open the UI in a normal browser')
    parser.add_argument('--headless', action='store_true', help='Start HTTP server only')
    args = parser.parse_args()
    os.environ['NO_PROXY'] = 'localhost,127.0.0.1,::1'
    os.environ['no_proxy'] = os.environ['NO_PROXY']
    httpd = ThreadingHTTPServer(('127.0.0.1', 7867), Handler)
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f'{APP_TITLE}: {url}', flush=True)
    if args.headless:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    elif args.browser:
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        try:
            import webview
            webview.create_window(APP_TITLE, url, width=1320, height=900,
                                  min_size=(940, 650), background_color='#ededed',
                                  js_api=NativeApi())
            webview.start(debug=False)
        except ImportError:
            print('pywebview not found: opening a normal browser.', flush=True)
            webbrowser.open(url)
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
        except Exception as e:
            print('WebView error:', e, flush=True)
            webbrowser.open(url)
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
    httpd.shutdown()


if __name__ == '__main__':
    main()
