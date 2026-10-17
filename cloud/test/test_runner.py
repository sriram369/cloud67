import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('runner',Path(__file__).parents[1]/'runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class RunnerBoundaries(unittest.TestCase):
    def test_public_catalog_paginates_and_excludes_private_or_foreign_repositories(self):
        calls=[]
        def fetcher(path):
            calls.append(path)
            if '?' not in path:return {'type':'Organization' if path.endswith('/team') else 'User'}
            if '/orgs/' in path:return [{'full_name':'team/project','private':False}]
            if 'page=2' in path:return [{'full_name':'owner/last','private':False},{'full_name':'owner/private','private':True},{'full_name':'other/repo','private':False}]
            return [{'full_name':f'owner/repo{i}','private':False} for i in range(100)]
        result=runner.github_catalog(['owner','team'],fetcher)
        self.assertEqual(len(result['repositories']),102)
        self.assertIn('/users/owner/repos?type=owner&sort=updated&per_page=100&page=2',calls)
        self.assertTrue(any('/orgs/team/repos?type=public' in c for c in calls))
        self.assertNotIn('owner/private',json.dumps(result))
        with self.assertRaises(ValueError):runner.github_catalog(['owner/../../secrets'],fetcher)

    def test_catalog_refresh_failure_retains_history_without_disclosing_error_credentials(self):
        class Offline:
            def post(self,*args):raise RuntimeError('secret-token-value')
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            runner.sync_repositories(Offline())
            self.assertNotIn('secret-token-value',output.getvalue())

    def test_service_requests_identify_cloud67(self):
        with patch.dict(os.environ,{'CLOUD67_URL':'https://cloud67.example','CLOUD67_RUNNER_TOKEN':'test-only'}):
            with patch.object(runner.urllib.request,'urlopen',return_value=io.BytesIO(b'{"turn":null}')) as request:
                self.assertEqual(runner.Client().post('/internal/v2/claim',{}),{'turn':None})
                sent=request.call_args.args[0]
                self.assertTrue(sent.get_header('User-agent').startswith('cloud67/'))
                self.assertEqual(sent.get_header('Authorization'),'Bearer test-only')

    def test_checkpoint_traversal_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';root.mkdir();(root/'escape').symlink_to(root.parent)
            for name in ['../secret','/etc/passwd','escape/secret']:
                with self.assertRaises(ValueError):runner.restore_state(root,{'files':{name:'bad'}})
            runner.restore_state(root,{'files':{'conversation/base_state.json':'{}'}})
            self.assertEqual((root/'conversation/base_state.json').read_text(),'{}')

    def test_model_token_is_removed_from_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'event.json').write_text(json.dumps({'text':'temporary-model-token'}))
            self.assertNotIn('temporary-model-token',json.dumps(runner.snapshot(root,'temporary-model-token')))

    def test_sandbox_credentials_and_write_modes(self):
        root=Path('/tmp/repository');state=Path('/tmp/state');control=Path('/tmp/control')
        with patch.dict(os.environ,{'GH_TOKEN':'publisher-secret','CLOUD67_RUNNER_TOKEN':'runner-secret'}):
            inspect=runner.sandbox_args('test',root,state,control,'inspect')
            edit=runner.sandbox_args('test',root,state,control,'edit')
            self.assertIn('/tmp/repository:/workspace:ro',inspect)
            self.assertIn('/tmp/repository:/workspace:rw',edit)
            self.assertIn('/tmp/repository/.git:/workspace/.git:ro',edit)
            self.assertIn('--cap-drop',inspect)
            self.assertNotIn('publisher-secret',' '.join(inspect))
            self.assertNotIn('runner-secret',' '.join(inspect))
            self.assertIn('none',runner.sandbox_args('test',root,state,control,'inspect',network=False))

    def test_repository_input_cannot_be_a_command_or_other_host(self):
        for value in ['https://evil.example/repo','owner/repo;printenv','owner/../secret','owner/..']:
            with self.assertRaises(ValueError):runner.repository_url(value)
        self.assertEqual(runner.repository_url('owner/repo'),'https://github.com/owner/repo.git')

    def test_generated_process_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError,'bounded output'):
                runner.run([sys.executable,'-c',"print('x'*500000)"],Path(tmp))

    def test_workflow_and_secret_paths_cannot_be_published(self):
        for name in ['.github/workflows/pwn.yml','.env','.env.production','service/private.key']:
            with patch.object(runner,'run',return_value=name+'\0'):
                with self.assertRaises(ValueError):runner.publication_files(Path('/tmp'))
        with patch.object(runner,'run',return_value='src/app.ts\0tests/app.test.ts\0'):
            self.assertEqual(len(runner.publication_files(Path('/tmp'))),2)

if __name__=='__main__':unittest.main()
