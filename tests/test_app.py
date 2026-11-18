import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

FAKE_TRELLIS = '''
from pathlib import Path
import json

TMP = Path.cwd() / "fake_tmp"
TMP.mkdir(exist_ok=True)

def initialize_pipeline(precision="full"):
    assert precision == "half", "FP16 is required"

def start_session(request):
    (TMP / request.session_hash).mkdir(exist_ok=True)

def end_session(request):
    pass

def preprocess_image(image):
    return image

def image_to_3d(image, multiimages, is_multiimage, seed, ss_guidance, ss_steps, slat_guidance, slat_steps, algo, request):
    assert image.size[0] > 0 and not is_multiimage
    preview = TMP / request.session_hash / 'sample.mp4'
    preview.write_bytes(b'FAKE-VIDEO-FOR-INTEGRATION-TEST')
    return {'seed':seed}, str(preview)

def extract_glb(state, simplify, texture_size, request):
    target = TMP / request.session_hash / 'sample.glb'
    target.write_bytes(b'glTF'+b'0'*16)
    return str(target), str(target)

def extract_gaussian(state, request):
    target = TMP / request.session_hash / 'sample.ply'
    target.write_bytes(b'ply\\nformat ascii 1.0\\nend_header\\n')
    return str(target), str(target)
'''

class TestAtelier(unittest.TestCase):
    def test_options_clamp_and_validation(self):
        cfg = app.sanitize_settings({'ss_steps': 100, 'slat_steps': 0, 'texture_size': 950})
        self.assertEqual(cfg['ss_steps'], 50)
        self.assertEqual(cfg['slat_steps'], 1)
        self.assertEqual(cfg['texture_size'], 512)
        with self.assertRaises(ValueError):
            app.sanitize_settings({'export_glb': False, 'export_ply': False})

    def test_worker_integration_with_test_double(self):
        # Fake engine is used ONLY in the test: the release app launches the actual user's TRELLIS.
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            code = root / 'TRELLIS' / 'code'
            code.mkdir(parents=True)
            (code / 'gradio_main.py').write_text(FAKE_TRELLIS, encoding='utf8')
            venv = code / 'venv' / ('Scripts' if os.name == 'nt' else 'bin')
            venv.mkdir(parents=True)
            interpreter = venv / ('python.exe' if os.name == 'nt' else 'python')
            try:
                if os.name == 'nt':
                    import shutil
                    shutil.copy(sys.executable, interpreter)
                else:
                    interpreter.symlink_to(sys.executable)
            except OSError:
                self.skipTest('Cannot create fake interpreter')
            uploads = root / 'uploads'
            uploads.mkdir()
            image_id = 'a' * 24
            Image.new('RGB', (32, 32), (180, 70, 50)).save(uploads / (image_id + '.png'))
            with patch.dict(os.environ, {'PYTHONPATH': os.pathsep.join(p for p in sys.path if p)}), \
                 patch.object(app, 'UPLOADS', uploads), \
                 patch.object(app, 'SETTINGS_FILE', root / 'settings.json'), \
                 patch.object(app, 'HISTORY_FILE', root / 'history.json'):
                manager = app.JobManager()
                manager.settings['trellis_path'] = str(root / 'TRELLIS')
                manager.settings['output_path'] = str(root / 'results')
                info = manager.start(image_id, {'export_ply': True})
                self.assertTrue(info['id'])
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    job = manager.status_get()
                    if job['status'] != 'running':
                        break
                    time.sleep(0.05)
                else:
                    self.fail('Worker timed out')
                self.assertEqual(job['status'], 'done', '\n'.join(job['logs']) + str(job['error']))
                self.assertTrue((Path(job['output_dir']) / 'model.glb').is_file())
                self.assertTrue((Path(job['output_dir']) / 'model.ply').is_file())
                self.assertTrue((Path(job['output_dir']) / 'preview.mp4').is_file())
                self.assertEqual(len(manager.history_get()), 1)

if __name__ == '__main__':
    unittest.main()

class TestMiniInterface(unittest.TestCase):
    def test_frontend_ids_and_compact_window(self):
        import re
        from collections import Counter
        root = Path(__file__).resolve().parents[1]
        html = (root / 'docs' / 'index.html').read_text(encoding='utf8')
        js = (root / 'docs' / 'app.js').read_text(encoding='utf8')
        ids = re.findall(r'\bid="([\w-]+)"', html)
        self.assertFalse([key for key, count in Counter(ids).items() if count != 1])
        missing = set(re.findall(r"\$\('([\w-]+)'\)", js)) - set(ids)
        self.assertFalse(missing, f'UI elements missing from HTML: {missing}')
        for field in ('image-input', 'generate-btn', 'progress-card', 'elapsed', 'eta',
                      'result-media', 'settings-panel', 'advanced-settings', 'downloads-list'):
            self.assertIn(field, ids)
        app_src = (root / 'app.py').read_text(encoding='utf8')
        self.assertIn("('127.0.0.1', 7867)", app_src)
