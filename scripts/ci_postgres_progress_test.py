import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('progress', Path(__file__).with_name('ci_postgres_progress.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProgressTests(unittest.TestCase):
    def test_reports_last_real_checkpoint_without_claiming_progress(self):
        out = io.BytesIO()
        code = 'import time;print("MIGRATION_SCENARIO_OK=1",flush=True);time.sleep(.25)'
        self.assertEqual(p.run([sys.executable, '-c', code], interval=.05, output=out), 0)
        text = out.getvalue().decode()
        self.assertIn('MIGRATION_SCENARIO_OK=1', text)
        self.assertIn('last_checkpoint=MIGRATION_SCENARIO_OK', text)
        self.assertIn('heartbeat is not proof of test progress', text)
        self.assertIn('exit=0', text)

    def test_failure_exit_and_stderr_are_not_changed_to_success(self):
        out = io.BytesIO()
        code = 'import sys;print("fixture failed",file=sys.stderr);sys.exit(7)'
        self.assertEqual(p.run([sys.executable, '-c', code], output=out), 7)
        self.assertIn(b'fixture failed', out.getvalue())
        self.assertIn(b'exit=7', out.getvalue())

    def test_no_checkpoint_during_silent_command_is_explicit(self):
        out = io.BytesIO()
        self.assertEqual(p.run([sys.executable, '-c', 'import time;time.sleep(.15)'],
                               interval=.04, output=out), 0)
        self.assertIn(b'last_checkpoint=none', out.getvalue())

    def test_signal_is_forwarded_and_does_not_become_success(self):
        # Only a disposable local fixture is interrupted; no CI job or Docker test.
        code = (
            'import importlib.util,io,sys;'
            's=importlib.util.spec_from_file_location("p",sys.argv[1]);'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
            'sys.exit(m.run([sys.executable,"-c",'
            '"import signal,time;signal.signal(signal.SIGTERM,lambda *_:exit(9));'
            'print(\\"READY\\",flush=True);time.sleep(30)"], interval=60))'
        )
        parent = subprocess.Popen([sys.executable, '-c', code, str(Path(p.__file__))],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(parent.stdout.readline().strip(), b'READY')
        parent.terminate()
        stdout, stderr = parent.communicate(timeout=5)
        self.assertEqual(parent.returncode, 9, stderr)
        self.assertIn(b'exit=9', stdout)


if __name__ == '__main__':
    unittest.main()
