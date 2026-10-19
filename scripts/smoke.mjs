import pkg from '../package.json' with { type: 'json' };

const target = new URL(process.argv[2] ?? 'http://localhost:8787');
if (target.username || target.password || target.search || target.hash || target.pathname !== '/' ||
    (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) {
  throw new Error('Use a origem HTTPS do serviço ou loopback HTTP local, sem credenciais.');
}
const health = await fetch(new URL('/health', target), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
if (!health.ok) throw new Error(`Health respondeu ${health.status}`);
const status = await health.json();
if (status.service !== 'whatsapp-mcp' || status.version !== pkg.version) throw new Error('Serviço ou versão inesperada.');
const privateFile = await fetch(new URL('/media/synthetic-smoke-no-real-file', target), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
if (privateFile.status !== 403) throw new Error(`Arquivo privado respondeu ${privateFile.status}; esperado acesso recusado.`);
console.log(JSON.stringify({service: status.service, version: status.version, maintenance: status.maintenance, privateAccessDenied: true}));
