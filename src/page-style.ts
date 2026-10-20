export const pageCss = `
:root{color-scheme:light;--ink:#18241e;--secondary:#4c5a50;--muted:#6c796f;--line:#dfe6df;--paper:#f6f8f5;--white:#fff;--green:#17623d;--green-dark:#104a2e;--soft:#eaf3ec;--focus:#126541}
*{box-sizing:border-box}
html{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink)}
body{margin:0;min-width:320px}
a{color:var(--green);text-underline-offset:3px}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.shell{max-width:1120px;margin:0 auto;padding:28px 32px 64px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;font-size:16px;font-weight:700;letter-spacing:-.025em}
.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--green);color:#fff;font-size:16px;font-weight:750;letter-spacing:-.06em}
.top-note{color:var(--muted);font-size:13px}
.content{max-width:680px;margin:0 auto;padding-top:64px}
.eyebrow{margin:0 0 12px;color:var(--green);font-size:12px;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
h1{margin:0;font-size:clamp(30px,4vw,42px);font-weight:650;line-height:1.13;letter-spacing:-.045em}
.intro{max-width:580px;margin:16px 0 32px;color:var(--secondary);font-size:16px;line-height:1.65}
.panel{background:var(--white);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 3px rgba(20,40,27,.04);overflow:hidden}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px 28px;border-bottom:1px solid var(--line)}
h2{margin:0;font-size:18px;font-weight:650;line-height:1.35;letter-spacing:-.025em}
.panel-subtitle{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.5}
.badge{display:inline-flex;align-items:center;gap:8px;flex:none;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#f8faf8;color:var(--secondary);font-size:12px;font-weight:650;white-space:nowrap}
.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#9aa79d}
.badge.pending:before{background:#b78018}.badge.active:before{background:var(--green)}
.panel-body{padding:28px}
.field{margin-bottom:20px}
label{display:block;margin-bottom:8px;font-size:13px;font-weight:650;color:var(--ink)}
.hint{display:block;margin-top:8px;color:var(--muted);font-size:12px;line-height:1.5}
input[type=text],input[type=password],input[type=url]{display:block;width:100%;min-height:46px;padding:11px 13px;border:1px solid #cbd7cd;border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:15px;transition:border-color .15s ease,box-shadow .15s ease}
input::placeholder{color:#8c988e}
input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(23,98,61,.1);outline:0}
.check-row{display:flex;align-items:flex-start;gap:12px;margin:24px 0;padding:16px;border:1px solid var(--line);border-radius:8px;background:#fafcf9}
.check-row input{width:18px;height:18px;min-width:18px;margin:1px 0 0;accent-color:var(--green)}
.check-row label{margin:0;font-size:13px;line-height:1.55;font-weight:550}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:11px 18px;border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;font:inherit;font-size:14px;font-weight:650;text-decoration:none;cursor:pointer;transition:background .15s ease}
.button:hover{background:var(--green-dark)}
.button.secondary{background:#fff;color:var(--green)}.button.secondary:hover{background:var(--soft)}
.button-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.setup-connect{margin-top:16px}
.state-copy{margin:0 0 24px;color:var(--secondary);font-size:14px;line-height:1.6}
.notice{margin:0 0 20px;padding:12px 16px;border:1px solid #bdd6c1;border-radius:8px;background:var(--soft);color:#174c31;font-size:13px;line-height:1.5}
.next{margin-top:24px;padding:24px 28px;border:1px solid var(--line);border-radius:12px;background:#fff}
.next h2{font-size:16px}.next p{margin:8px 0 0;color:var(--secondary);font-size:14px;line-height:1.6}
.steps{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.step{padding:7px 10px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:12px;font-weight:600}
.step.current{background:var(--soft);border-color:#bdd6c1;color:var(--green)}
.mcp-label{display:block;margin:24px 0 8px;font-size:13px;font-weight:650}.mcp-url{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.footnote{max-width:620px;margin:24px 0 0;color:var(--muted);font-size:12px;line-height:1.65}
@media(max-width:600px){.shell{padding:20px 16px 40px}.topbar{padding-bottom:20px}.top-note{display:none}.content{padding-top:40px}.intro{font-size:15px;margin-bottom:24px}.panel-head{display:block;padding:20px}.badge{margin-top:16px}.panel-body{padding:20px}.next{padding:20px}.button{width:100%}.button-row{display:block}}
`;
