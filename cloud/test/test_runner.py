import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('runner',Path(__file__).parents[1]/'runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class RunnerBoundaries(unittest.TestCase):
    def test_escape_and_harness_writes_are_denied(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve()
            for path in ['../../.env','cloud/worker.mjs','/etc/passwd','cloud/agent-workspace/../../runner.py']:
                with self.assertRaises(ValueError):runner.workspace_path(root,path,write=True)
            self.assertEqual(runner.workspace_path(root,'cloud/agent-workspace/util.py',write=True),root/'cloud/agent-workspace/util.py')
    def test_symlink_escape_is_denied(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/runner.SCOPE).mkdir(parents=True)
            (root/runner.SCOPE/'link').symlink_to('/tmp')
            with self.assertRaises(ValueError):runner.workspace_path(root,'cloud/agent-workspace/link/x.py',write=True)
    def test_only_known_actions_and_python_writes(self):
        with self.assertRaises(ValueError):runner.parse_action('{"action":"shell","command":"printenv"}')
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):runner.workspace_path(Path(tmp),'cloud/agent-workspace/run.sh',write=True)
    def test_no_test_files_is_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'At least one test'):runner.execute(Path(tmp),{'action':'run_tests'})

if __name__=='__main__':unittest.main()
