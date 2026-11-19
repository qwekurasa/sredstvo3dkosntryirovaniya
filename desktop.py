"""Windows desktop window for Sredstvo 3D. Uses installed Edge/Chrome in app mode.

Single process owns the loopback HTTP server, opens the application window,
and shuts down when the dedicated browser app process exits.
"""
from __future__ import annotations
import os
import shutil
import subprocess
import sys
import time
import traceback
import webbrowser
from pathlib import Path
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import build_opener, ProxyHandler
import app

HOME = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'Sredstvo3D'
HOME.mkdir(parents=True,exist_ok=True)
LOG = HOME / 'launcher.log'


def browser_path():
    for key in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'):
        base = os.environ.get(key)
        if base:
            for folder in ('Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'):
                p = Path(base) / folder
                if p.is_file():
                    return str(p)
    return shutil.which('msedge') or shutil.which('chrome')


def main():
    own_server = True
    server = None
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 7867), app.Handler)
        Thread(target=server.serve_forever, daemon=True).start()
    except OSError:
        own_server = False
        # Only reuse if the current service is our own local app.
        try:
            with build_opener(ProxyHandler({})).open('http://127.0.0.1:7867/api/health', timeout=3) as r:
                if b'Sredstvo3D' not in r.read():
                    raise RuntimeError('Порт 7867 занят другим приложением')
        except Exception as exc:
            raise RuntimeError('Порт 7867 занят. Закройте другое приложение или процесс.') from exc
    url = 'http://127.0.0.1:7867/'
    try:
        browser = browser_path()
        if browser:
            profile = HOME / 'app-browser-profile'
            args = [browser, '--app='+url, '--new-window',
                    '--user-data-dir='+str(profile), '--no-first-run',
                    '--window-size=1390,930', '--disable-extensions']
            process = subprocess.Popen(args, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            process.wait()
        else:
            # Fallback: no Edge/Chrome. Works but closes only after terminal process exit.
            webbrowser.open(url)
            while True:
                time.sleep(1)
    finally:
        if own_server and server is not None:
            server.shutdown()
            server.server_close()


def show_error(error):
    with LOG.open('a', encoding='utf-8') as f:
        f.write('\n' + traceback.format_exc() + '\n')
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, str(error)+'\n\nЖурнал: '+str(LOG), 'Средство 3D — ошибка', 0x10)
    except Exception:
        print(str(error), file=sys.stderr)


if __name__=='__main__':
    try:
        main()
    except Exception as e:
        show_error(e)
        sys.exit(1)
