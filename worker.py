"""Subprocess entry point. Runs in the EXISTING TRELLIS venv, not in the UI venv.

It deliberately calls the user's original gradio_main.py functions so it uses the
same checkpoint, FP16 mode and mesh extraction implementation as the working fork.
"""
import argparse
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

PREFIX = 'ATELIER_EVENT:'


def notify(stage, message, **other):
    print(PREFIX + json.dumps({'stage': stage, 'message': message, **other}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--code-dir', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--settings', required=True)
    args = parser.parse_args()
    opts = json.loads(args.settings)
    code_dir = Path(args.code_dir).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not (code_dir / 'gradio_main.py').is_file():
        raise FileNotFoundError(f'TRELLIS code not found in {code_dir}')

    # gradio_main has its own argparse.parse_args() at module import time.
    # Remove our custom CLI arguments before importing it.
    sys.argv = ['gradio_main.py', '--precision', 'half']
    sys.path.insert(0, str(code_dir))
    os.chdir(code_dir)  # original Gradio code resolves assets relative to cwd
    os.environ['NO_PROXY'] = 'localhost,127.0.0.1,::1'
    os.environ['no_proxy'] = 'localhost,127.0.0.1,::1'
    os.environ['PYTHONUNBUFFERED'] = '1'

    notify('loading', 'Загрузка TRELLIS в FP16')
    import gradio_main as trellis
    from PIL import Image
    trellis.initialize_pipeline('half')

    notify('preparing', 'Подготовка изображения')
    request = type('Session', (), {'session_hash': args.job_id})()
    trellis.start_session(request)
    try:
        with Image.open(args.image) as im:
            image = im.convert('RGBA')
        image = trellis.preprocess_image(image)

        notify('generating', 'Создание 3D-модели и видеопревью')
        state, preview_path = trellis.image_to_3d(
            image, [], False,
            int(opts['seed']),
            float(opts['ss_guidance']),
            int(opts['ss_steps']),
            float(opts['slat_guidance']),
            int(opts['slat_steps']),
            'stochastic',
            request
        )
        shutil.copy2(preview_path, output / 'preview.mp4')
        notify('exporting', 'Экспорт модели')
        exported = {}
        if opts.get('export_glb', True):
            glb_path, _ = trellis.extract_glb(
                state, float(opts['simplify']), int(opts['texture_size']), request
            )
            shutil.copy2(glb_path, output / 'model.glb')
            exported['glb'] = 'model.glb'
        if opts.get('export_ply', False):
            ply_path, _ = trellis.extract_gaussian(state, request)
            shutil.copy2(ply_path, output / 'model.ply')
            exported['ply'] = 'model.ply'
        exported['preview'] = 'preview.mp4'
        notify('complete', 'Готово! Модель сохранена', files=exported)
    finally:
        try:
            trellis.end_session(request)
        except Exception as exc:
            print('Cleanup warning:', exc, flush=True)


if __name__ == '__main__':
    try:
        main()
    except BaseException as exc:
        notify('error', str(exc), traceback=traceback.format_exc())
        sys.exit(1)
