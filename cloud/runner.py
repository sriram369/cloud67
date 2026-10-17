"""Trusted controller; OpenHands runs in Docker without publisher credentials."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

IMAGE='cloud67-openhands:1.55.1'
PROTECTED=('.github/','.git/','.cloud67/','.aws/','.ssh/','.venv/','node_modules/')

def bounded(value,size=12000):return str(value).encode()[:size].decode(errors='ignore')

class Client:
    def __init__(self):
        self.url=os.environ['CLOUD67_URL'].rstrip('/');self.token=os.environ['CLOUD67_RUNNER_TOKEN']
        if not self.url.startswith('https://'):raise ValueError('HTTPS required')
    def post(self,path,data):
        req=urllib.request.Request(self.url+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+self.token,'User-Agent':'cloud67/0.2 (+https://github.com/sriram369/cloud67)'})
        try:
            with urllib.request.urlopen(req,timeout=120) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            try:message=json.load(e).get('error','Request failed')
            except Exception:message='Request failed'
            raise RuntimeError(f'Cloud67 {e.code}: {message}') from None

def safe_path(root,value):
    if not isinstance(value,str) or '\0' in value or Path(value).is_absolute():raise ValueError('Invalid checkpoint path')
    path=(root/value).resolve()
    if not path.is_relative_to(root.resolve()) or path==root.resolve():raise ValueError('Checkpoint path escapes state directory')
    return path

def restore_state(root,checkpoint):
    files=(checkpoint or {}).get('files',{})
    if not isinstance(files,dict) or len(files)>200 or len(json.dumps(files).encode())>500000:raise ValueError('Invalid conversation checkpoint')
    for name,content in files.items():
        if not isinstance(content,str):raise ValueError('Invalid checkpoint content')
        path=safe_path(root,name);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)

def snapshot(root,token):
    files={}
    for path in root.rglob('*.json'):
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):raise ValueError('Invalid state file')
        if path.stat().st_size>400000:raise ValueError('Conversation state file is too large')
        files[str(path.relative_to(root))]=path.read_text().replace(token,'[expired model token]')
    if len(files)>200 or len(json.dumps(files).encode())>480000:raise ValueError('Conversation checkpoint exceeds storage limit')
    return files

def git_environment():
    env=os.environ.copy();env.update({'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'core.hooksPath','GIT_CONFIG_VALUE_0':os.devnull})
    return env

def run(args,root,*,env=None,timeout=120,input=None):
    p=subprocess.Popen(args,cwd=root,env=env,stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,errors='replace')
    chunks=[];size=0;overflow=False
    def collect():
        nonlocal size,overflow
        while True:
            chunk=p.stdout.read(8192)
            if not chunk:break
            size+=len(chunk.encode())
            if size>200000:overflow=True;p.kill();break
            chunks.append(chunk)
    reader=threading.Thread(target=collect,daemon=True);reader.start()
    if input is not None:p.stdin.write(input);p.stdin.close()
    try:p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:p.kill();p.wait();raise RuntimeError('Command reached its execution timeout') from None
    finally:reader.join(timeout=5);p.stdout.close()
    output=''.join(chunks)
    if overflow:raise RuntimeError('Command exceeded its bounded output allowance')
    if p.returncode:raise RuntimeError(bounded(output,10000))
    return output

def repository_url(repository):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}',repository) or repository.split('/')[1] in ('.','..'):raise ValueError('Invalid repository')
    return 'https://github.com/'+repository+'.git'

def checkout(root,conversation,checkpoint):
    env=git_environment();sha=conversation['base_sha']
    if not re.fullmatch('[a-f0-9]{40}',sha):raise ValueError('Invalid repository revision')
    run(['git','init','--quiet',str(root)],root.parent,env=env)
    run(['git','remote','add','origin',repository_url(conversation['repository'])],root,env=env)
    run(['git','fetch','--quiet','--depth=30','origin',sha],root,env=env,timeout=120)
    run(['git','checkout','--quiet','--detach','FETCH_HEAD'],root,env=env)
    patch=(checkpoint or {}).get('patch')
    if patch:run(['git','apply','--binary','-'],root,env=env,input=patch)

def sandbox_args(name,root,state,control,mode,*,network=True):
    if mode not in ('inspect','edit'):raise ValueError('Invalid workspace mode')
    return ['docker','run','--rm','--name',name,'--init','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','256','--memory','2g','--cpus','2','--user',f'{os.getuid()}:{os.getgid()}','--read-only',
        '--tmpfs','/tmp:rw,nosuid,size=512m','--network','bridge' if network else 'none',
        '-e','HOME=/tmp/home','-e','PYTHONDONTWRITEBYTECODE=1','-v',str(root)+':/workspace:'+('rw' if mode=='edit' else 'ro'),
        '-v',str(root/'.git')+':/workspace/.git:ro','-v',str(state)+':/state:rw','-v',str(control)+':/control:rw','-w','/workspace',IMAGE]

def stage_patch(root):
    env=git_environment();run(['git','add','--all'],root,env=env)
    patch=run(['git','--no-pager','diff','--no-ext-diff','--no-textconv','--binary','--cached','HEAD'],root,env=env)
    if len(patch.encode())>120000:raise ValueError('Patch exceeds review limit; split this change')
    return patch

def publication_files(root):
    files=[p for p in run(['git','diff','--cached','--name-only','-z'],root,env=git_environment()).split('\0') if p]
    for path in files:
        name=Path(path).name
        if path.startswith(PROTECTED) or name=='.env' or (name.startswith('.env.') and name!='.env.example') or name.endswith(('.pem','.key')):raise ValueError('Protected files need owner review; the patch is preserved without publication')
    return files

def publish(root,conversation,turn,client):
    if conversation['repository'].lower()!=os.environ['GITHUB_REPOSITORY'].lower():raise ValueError('Publisher repository mismatch')
    if not publication_files(root):return None
    client.post('/internal/v2/turns/'+turn['id']+'/heartbeat',{'lease':turn['lease']})
    env=git_environment();branch='cloud67/conversation-'+turn['id']
    env.update({'GIT_AUTHOR_NAME':'cloud67 agent','GIT_AUTHOR_EMAIL':'cloud67@users.noreply.github.com','GIT_COMMITTER_NAME':'cloud67 agent','GIT_COMMITTER_EMAIL':'cloud67@users.noreply.github.com'})
    run(['git','switch','-c',branch],root,env=env);run(['git','diff','--cached','--check'],root,env=env)
    run(['git','commit','--quiet','-m','feat: cloud67 OpenHands conversation '+turn['id'][:8]],root,env=env)
    token=os.environ.get('GH_TOKEN')
    if not token:raise ValueError('Publisher token is unavailable')
    auth=base64.b64encode(('x-access-token:'+token).encode()).decode()
    env.update({'GIT_CONFIG_COUNT':'2','GIT_CONFIG_KEY_1':'http.https://github.com/.extraheader','GIT_CONFIG_VALUE_1':'AUTHORIZATION: basic '+auth})
    run(['git','push','--quiet','origin',branch],root,env=env)
    return 'https://github.com/'+conversation['repository']+'/compare/'+conversation['branch']+'...'+branch+'?expand=1'

def main():
    client=Client();claimed=client.post('/internal/v2/claim',{});turn=claimed.get('turn')
    if not turn:print('No queued OpenHands conversation.');return
    if not re.fullmatch(r'[a-f0-9-]{36}',turn['id']):raise ValueError('Invalid run identifier')
    conversation=claimed['conversation'];base='/internal/v2/turns/'+turn['id'];lease={'lease':turn['lease']};source=Path(__file__).resolve().parent
    def emit(kind,content,**extra):client.post(base+'/events',{**lease,'kind':kind,'content':bounded(content),**extra})
    patch='';checkpoint=None;answer='';branch=None;name='cloud67-'+turn['id'];temporary=None
    try:
        url='https://github.com/'+os.environ['GITHUB_REPOSITORY']+'/actions/runs/'+os.environ['GITHUB_RUN_ID']
        emit('runner','Preparing OpenHands SDK 1.55.1.',runner_url=url)
        run(['docker','build','--quiet','--file',str(source/'Dockerfile.agent'),'--tag',IMAGE,str(source)],source,timeout=300)
        temporary=tempfile.TemporaryDirectory(prefix='cloud67-run-');work=Path(temporary.name);root=work/'repository';state=work/'state';control=work/'control'
        state.mkdir();control.mkdir();checkout(root,conversation,claimed.get('checkpoint'));restore_state(state,claimed.get('checkpoint'))
        shutil.copyfile(source/'openhands_agent.py',control/'agent.py')
        (control/'input.json').write_text(json.dumps({'conversation':conversation,'prompt':turn['prompt'],'model_token':claimed['model_token'],'model_base_url':client.url+'/agent/'+turn['id']+'/v1'}))
        emit('repository',json.dumps({'repository':conversation['repository'],'branch':conversation['branch'],'sha':conversation['base_sha'],'mode':conversation['mode']}))
        process=subprocess.Popen(sandbox_args(name,root,state,control,conversation['mode'])+['python','/control/agent.py'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env={'PATH':os.environ['PATH']})
        output=[]
        def drain():
            for line in iter(lambda:process.stdout.readline(24000),''):
                if line.startswith('CLOUD67_EVENT '):
                    try:
                        event=json.loads(line[len('CLOUD67_EVENT '):]);emit(event['kind'],event['content'],event_key=turn['id']+':'+event['id'])
                    except Exception:pass
                elif len(output)<30:output.append(bounded(line,1000))
        thread=threading.Thread(target=drain,daemon=True);thread.start();started=time.monotonic()
        while process.poll() is None:
            if time.monotonic()-started>600:raise RuntimeError('Cloud turn reached its ten-minute execution limit')
            client.post(base+'/heartbeat',lease);time.sleep(5)
        thread.join(timeout=15)
        checkpoint={'files':snapshot(state,claimed['model_token']),'patch':''}
        patch=stage_patch(root) if conversation['mode']=='edit' else '';checkpoint['patch']=patch
        report_path=control/'report.json'
        if not report_path.is_file() or report_path.stat().st_size>50000:raise RuntimeError('OpenHands did not return a valid report. '+bounded('\n'.join(output),2500))
        report=json.loads(report_path.read_text());answer=bounded(report.get('answer',''),16000)
        if report.get('status')!='finished' or process.returncode:raise RuntimeError(report.get('error') or 'OpenHands stopped before finishing this turn')
        status='completed' if report.get('tool_results',0)>0 else 'needs_input'
        if conversation['mode']=='edit' and patch:
            emit('verification','Running configured verification: '+conversation['test_command'])
            verified=run(sandbox_args(name+'-verify',root,state,control,'inspect',network=False)+['sh','-lc',conversation['test_command']],root,env={'PATH':os.environ['PATH']},timeout=120)
            emit('verification_passed',bounded(verified) or 'Verification exited successfully (code 0).')
            branch=publish(root,conversation,turn,client)
            if branch:emit('publication','Verified branch published: '+branch)
        client.post(base+'/finish',{**lease,'status':status,'answer':answer or 'The agent needs a more specific instruction.','patch':patch,'checkpoint':checkpoint,'branch_url':branch})
        print('OpenHands turn:',status,'branch:',branch or 'none')
    except Exception as e:
        message=bounded(e,4000)
        try:client.post(base+'/finish',{**lease,'status':'failed','answer':answer,'error':message,'patch':patch,'checkpoint':checkpoint})
        except Exception:pass
        print('OpenHands turn stopped:',message);raise SystemExit(1)
    finally:
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':os.environ['PATH']})
        subprocess.run(['docker','rm','-f',name+'-verify'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':os.environ['PATH']})
        if temporary:temporary.cleanup()

if __name__=='__main__':main()
