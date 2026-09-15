import { test, type TestContext } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AppServer, type RpcId, type RpcMessage } from '../../src/direct/app-server.js'
import { DirectRelay } from '../../src/direct/relay.js'
import { Journal, verifyWorkspace } from '../../src/direct/binding.js'

test('configured workspace identity rejects credentials from a different Slack workspace', () => {
  assert.doesNotThrow(() => verifyWorkspace('constructioncopilot.slack.com', 'https://constructioncopilot.slack.com/'))
  assert.throws(() => verifyWorkspace('constructioncopilot.slack.com', 'https://another.slack.com/'), /do not belong/)
  assert.throws(() => verifyWorkspace('constructioncopilot.slack.com', undefined), /did not identify/)
})

const binding = { threadId: 'selected-task', channelId: 'C123', ownerId: 'U123' }
class FakeRpc extends EventEmitter {
  calls: { method: string; params: Record<string, unknown> }[] = []; responses: { id: RpcId; result: unknown }[] = []; rejected: RpcId[] = []; failStart = false
  async request(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params })
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } }
    if (method === 'turn/start') {
      if (this.failStart) throw new Error('timed out; not retried')
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 't1' } } })
      return { turn: { id: 't1' } }
    }
    return {}
  }
  respond(id: RpcId, result: unknown) { this.responses.push({ id, result }) }
  reject(id: RpcId) { this.rejected.push(id) }
}
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-direct-'))
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const rpc = new FakeRpc(); const posts: string[] = []; const errors: unknown[] = []
  const journal = new Journal(path.join(dir, 'delivery.json'))
  const relay = new DirectRelay(rpc, binding, journal, async text => { posts.push(text) }, e => errors.push(e))
  const event = { id: 'e1', user: 'U123', channel: 'C123', text: 'hello' }
  return { rpc, posts, relay, journal, dir, event, errors }
}

test('direct connection resumes exactly one task without listing or importing history', async t => {
  const { rpc, relay, event } = fixture(t)
  await relay.connect()
  await relay.receive({ ...event, user: 'OTHER' })
  await relay.receive({ ...event, channel: 'OTHER' })
  await relay.receive({ ...event, bot_id: 'B123' })
  assert.deepEqual(rpc.calls, [{ method: 'thread/resume', params: { threadId: 'selected-task', excludeTurns: true } }])
  await relay.receive(event)
  await relay.receive(event)
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  assert.equal(rpc.calls[1].params.threadId, 'selected-task')
})

test('only bridge-owned turn text is forwarded; other agents, history and tools stay private', async t => {
  const { rpc, relay, posts, event } = fixture(t)
  await relay.connect(); await relay.receive(event)
  const notify = (threadId: string, turnId: string, type: string, id: string, text: string) => rpc.emit('notification', {
    method: 'item/completed', params: { threadId, turnId, item: { type, id, text } },
  })
  notify('another-task', 't1', 'agentMessage', 'i1', 'private other task')
  notify('selected-task', 'old-turn', 'agentMessage', 'i2', 'old conversation')
  notify('selected-task', 't1', 'commandExecution', 'i3', 'secret tool output')
  notify('selected-task', 't1', 'agentMessage', 'i4', 'answer')
  notify('selected-task', 't1', 'agentMessage', 'i4', 'answer')
  await relay.flush()
  assert.deepEqual(posts, ['answer'])
})

test('uncertain prompt delivery is not replayed, including after restart', async t => {
  const { rpc, relay, event, dir, posts } = fixture(t)
  rpc.failStart = true
  await relay.connect(); await relay.receive(event)
  const restarted = new DirectRelay(rpc, binding, new Journal(path.join(dir, 'delivery.json')), async text => { posts.push(text) })
  await restarted.receive(event)
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  assert.match(posts[0], /not retried/)
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'delivery.json'), 'utf8'), /hello/)
})

test('approval decisions bind to the owner and exact live turn; stale decisions are rejected', async t => {
  const { rpc, relay, posts, event } = fixture(t)
  await relay.connect(); await relay.receive(event)
  rpc.emit('request', { id: 7, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'selected-task', turnId: 't1', command: 'run tests' } })
  await relay.flush()
  const key = /approve (\S+)`/.exec(posts[0])![1]
  await relay.receive({ ...event, id: 'e2', user: 'intruder', text: `approve ${key}` })
  assert.equal(rpc.responses.length, 0)
  await relay.receive({ ...event, id: 'e3', text: `approve ${key}` })
  assert.deepEqual(rpc.responses, [{ id: 7, result: { decision: 'accept' } }])
  await relay.receive({ ...event, id: 'e4', text: `approve ${key}` })
  assert.equal(rpc.responses.length, 1)
  assert.match(posts.at(-1)!, /expired/)
})

test('stop targets the exact bridge turn and busy prompts are not injected', async t => {
  const { rpc, relay, posts, event } = fixture(t)
  await relay.connect(); await relay.receive(event)
  await relay.receive({ ...event, id: 'e2', text: 'more work' })
  assert.match(posts[0], /busy/)
  await relay.receive({ ...event, id: 'e3', text: '/sab-stop' })
  assert.deepEqual(rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'selected-task', turnId: 't1' } })
})

test('output and approvals remain bound to the exact Slack reply root', async t => {
  const rpc = new FakeRpc()
  const event = {id:'root-event',user:'U123',channel:'C123',text:'hello'}
  const posts: {text:string;root?:string}[] = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sab-root-'))
  t.onTestFinished(() => fs.rmSync(dir,{recursive:true,force:true}))
  const routed = new DirectRelay(rpc,binding,new Journal(path.join(dir,'journal.json')),async(text,root)=>{posts.push({text,root})})
  await routed.connect()
  await routed.receive({...event,threadTs:'100.001'})
  rpc.emit('request',{id:9,method:'item/commandExecution/requestApproval',params:{threadId:binding.threadId,turnId:'t1',command:'test'}})
  await routed.flush()
  assert.equal(posts[0].root,'100.001')
  const key=/approve (\S+)`/.exec(posts[0].text)![1]
  await routed.receive({...event,id:'wrong-root',threadTs:'100.002',text:`approve ${key}`})
  assert.equal(rpc.responses.length,0)
  await routed.receive({...event,id:'right-root',threadTs:'100.001',text:`deny ${key}`})
  assert.deepEqual(rpc.responses,[{id:9,result:{decision:'decline'}}])
})

test('shared collaborators get labelled prompts but cannot approve or stop', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sab-share-'))
  t.onTestFinished(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const rpc=new FakeRpc(), posts:string[]=[]
  const relay=new DirectRelay(rpc,{...binding,collaboratorIds:['UCOLLAB']},new Journal(path.join(dir,'journal.json')),async text=>{posts.push(text)})
  const event={id:'shared',channel:'C123',user:'UCOLLAB',text:'hello',threadTs:'100.001'}
  await relay.connect();await relay.receive(event)
  assert.match(JSON.stringify(rpc.calls.at(-1)),/Slack collaborator UCOLLAB/)
  await relay.receive({...event,id:'stop',text:'sab stop'})
  assert.equal(rpc.calls.filter(c=>c.method==='turn/interrupt').length,0)
  assert.match(posts.at(-1)!,/Only the agent owner/)
})

test('Slack file shares fail visibly instead of silently dropping an attachment', async t => {
  const { rpc, relay, posts, event } = fixture(t)
  await relay.connect()
  await relay.receive({ ...event, subtype: 'file_share', hasFiles: true })
  assert.match(posts[0], /Files were not sent/)
  assert.equal(rpc.calls.length, 1)
})

test('an uncertain start fences subsequent new prompts until reconnect', async t => {
  const { rpc, relay, posts, event } = fixture(t)
  await relay.connect()
  rpc.failStart = true
  await relay.receive(event)
  rpc.failStart = false
  await relay.receive({ ...event, id: 'e2' })
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  assert.match(posts.at(-1)!, /Restart the bridge/)
})

test('a fast completed turn cannot become busy again when the RPC response arrives late', async t => {
  const { rpc, relay, event, posts } = fixture(t)
  await relay.connect()
  const normalRequest = rpc.request.bind(rpc)
  rpc.request = async (method, params) => {
    const result = await normalRequest(method, params)
    if (method === 'turn/start') {
      rpc.emit('notification', { method: 'turn/completed', params: {
        threadId: binding.threadId, turn: { id: 't1', status: 'completed' },
      } })
      await relay.flush()
    }
    return result
  }
  await relay.receive(event)
  await relay.receive({ ...event, id: 'e2', text: '/sab-status' })
  assert.match(posts.at(-1)!, /ready/)
})

test('stdio client handles real subprocess RPC, server requests, timeouts, and exit without a terminal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-rpc-'))
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const script = path.join(dir, 'fake.mjs')
  fs.writeFileSync(script, `import {createInterface} from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line', l=>{
 const m=JSON.parse(l);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='echo') send({id:m.id,result:m.params});
 if(m.method==='question') {send({id:99,method:'approval',params:{}});send({id:m.id,result:{}})}
 if(m.method==='exit') process.exit(1);
});`)
  const rpc = new AppServer(process.execPath, [script], 3000)
  t.onTestFinished(() => rpc.close())
  await rpc.start()
  assert.deepEqual(await rpc.request('echo', { text: 'literal " text\n$()' }), { text: 'literal " text\n$()' })
  let question: RpcMessage | undefined
  rpc.on('request', request => { question = request; rpc.respond(request.id, { decision: 'decline' }) })
  await rpc.request('question')
  assert.equal(question?.id, 99)
  await assert.rejects(rpc.request('never'), /not retried/)
  await assert.rejects(rpc.request('exit'), /disconnected/)
})
