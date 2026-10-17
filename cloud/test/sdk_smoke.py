"""Actual OpenHands SDK + file tool + checkpoint round-trip, with a local mock LLM."""
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import uuid
import importlib.util

os.environ.update({'OPENHANDS_SUPPRESS_BANNER':'1','LITELLM_LOCAL_MODEL_COST_MAP':'True','OTEL_SDK_DISABLED':'true'})
from openhands.sdk import LLM,Agent,Conversation,Tool
from openhands.tools.file_editor import FileEditorTool

def main():
    spec=importlib.util.spec_from_file_location('cloud67_agent',Path(__file__).parents[1]/'openhands_agent.py')
    adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
    configured=adapter.create_agent({'conversation':{'repository':'owner/repo','base_sha':'a'*40,'mode':'inspect'},'model_base_url':'http://127.0.0.1:1/v1','model_token':'test-only'})
    assert configured.llm.num_retries==0 and configured.llm.api_mode=='chat'
    assert len(configured.tools)==1
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp);target=root/'sdk-proof.txt';calls=[];events=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                request=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(request)
                names=[t['function']['name'] for t in request['tools']]
                step=len(calls)
                if step in (1,3):
                    name=next(n for n in names if 'file_editor' in n.lower())
                    args={'command':'create','path':str(target),'file_text':'OpenHands checkpoint proof'} if step==1 else {'command':'view','path':str(target)}
                else:name=next(n for n in names if 'finish' in n.lower());args={'message':'OpenHands checkpoint proof'}
                response={'id':'mock-'+str(step),'object':'chat.completion','created':1,'model':'cloud67-free','choices':[{'index':0,'message':{'role':'assistant','content':None,'tool_calls':[{'id':'call-'+str(step),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]},'finish_reason':'tool_calls'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}
                data=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            def agent():
                return Agent(llm=LLM(model='openai/cloud67-free',base_url=f'http://127.0.0.1:{server.server_port}/v1',api_key='mock-only',api_mode='chat',num_retries=0,max_input_tokens=24000,max_output_tokens=2048,input_cost_per_token=0,output_cost_per_token=0),tools=[Tool(name=FileEditorTool.name)],include_default_tools=['FinishTool'])
            identifier=uuid.uuid4()
            first=Conversation(agent=agent(),workspace=str(root),conversation_id=identifier,persistence_dir=str(root/'state'),callbacks=[events.append],visualizer=None,max_iteration_per_run=4)
            first.send_message('Write sdk-proof.txt containing OpenHands checkpoint proof.');first.run()
            assert first.state.execution_status.value=='finished'
            assert target.read_text().strip()=='OpenHands checkpoint proof'
            first.close()
            second=Conversation(agent=agent(),workspace=str(root),conversation_id=identifier,persistence_dir=str(root/'state'),callbacks=[events.append],visualizer=None,max_iteration_per_run=4)
            second.send_message('Read the file from the previous turn and report its contents.');second.run()
            assert second.state.execution_status.value=='finished'
            assert len(calls)==4
            assert any('Write sdk-proof.txt' in str(m.get('content','')) for m in calls[2]['messages'])
            assert any(type(event).__name__=='ObservationEvent' for event in events)
            assert any(adapter.is_repository_observation(event) for event in events)
            assert all(not adapter.is_repository_observation(event) for event in events if getattr(event,'tool_name',None)=='finish')
            second.close()
            print('OpenHands 1.55.1: file tool, native tool calls, and persisted follow-up passed (mock LLM; no provider calls).')
        finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
