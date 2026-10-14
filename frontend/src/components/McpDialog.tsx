import { useEffect, useRef, useState } from 'react';
import { getProjectId, getWriteKey } from '../api';
import { Modal } from './Modal';

// navigator.clipboard only exists in secure contexts (https/localhost), so on a LAN http address fall back to execCommand.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const preRef = useRef<HTMLPreElement>(null);
  const copy = async () => {
    const ok = await copyText(text);
    if (!ok && preRef.current) { const r = document.createRange(); r.selectNodeContents(preRef.current); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
    setStatus(ok ? 'ok' : 'fail');
    setTimeout(() => setStatus('idle'), 2500);
  };
  return (
    <div className="mcp-code">
      <pre ref={preRef}>{text}</pre>
      <button type="button" className={status === 'ok' ? 'copied' : status === 'fail' ? 'failed' : ''} aria-label={`Copy ${label}`} onClick={copy}>
        {status === 'ok' ? 'Copied ✓' : status === 'fail' ? 'Press Ctrl+C' : 'Copy'}
      </button>
      <span className="sr-only" role="status">{status === 'ok' ? 'Copied to clipboard' : status === 'fail' ? 'Copy failed, text selected, press Ctrl+C' : ''}</span>
    </div>
  );
}

// Keep in step with the folders under mcp/skills.
const SKILLS = [
  { name: 'pjplanner-map', about: 'maps the codebase into modules and dependencies.' },
  { name: 'pjplanner-breakdown', about: 'breaks a story or epic into tasks, per module.' },
];

export function McpDialog({ onClose }: { onClose: () => void }) {
  // Address and key come from the server so the command uses its LAN IP instead of the browser's localhost.
  const [info, setInfo] = useState<{ url: string } | null>(null);
  useEffect(() => {
    fetch('/api/mcp/info').then((r) => r.json()).then(setInfo).catch(() => setInfo({ url: window.location.origin }));
  }, []);
  const url = info?.url ?? window.location.origin;
  // The server never reveals the key: use the one entered in the header lock, else a placeholder to fill in.
  const key = getWriteKey() || '<WRITE_KEY from .env>';
  // Pin the agent to the project open in the UI; without it the server falls back to the oldest project.
  const projectId = getProjectId();
  const dir = '~/.pjplanner';
  const file = `${dir}/pjplanner-mcp.mjs`;
  const add = `claude mcp add pjplanner -e PJPLANNER_URL=${url} -e PJPLANNER_API_KEY=${key}${projectId ? ` -e PJPLANNER_PROJECT=${projectId}` : ''} -- node ${file}`;
  // One paste: fetch the file into a fixed folder, then register it, so nobody has to place it by hand.
  const cmd = `mkdir -p ${dir} && curl -fsSL ${url}/api/mcp/download -o ${file} && ${add}`;
  // Optional skill suite: one folder per skill under ~/.claude/skills, all fetched by one paste.
  const skillNames = SKILLS.map((k) => k.name).join(' ');
  const skillCmd = `for s in ${skillNames}; do mkdir -p ~/.claude/skills/$s && curl -fsSL ${url}/api/mcp/skills/$s -o ~/.claude/skills/$s/SKILL.md; done`;
  const removeMcp = `claude mcp remove pjplanner && rm -rf ${dir}`;
  const removeSkill = `rm -rf ${SKILLS.map((k) => `~/.claude/skills/${k.name}`).join(' ')}`;
  const config = JSON.stringify({ mcpServers: { pjplanner: { command: 'node', args: ['<full path to pjplanner-mcp.mjs>'], env: { PJPLANNER_URL: url, PJPLANNER_API_KEY: key, ...(projectId ? { PJPLANNER_PROJECT: String(projectId) } : {}) } } } }, null, 2);
  return (
    <Modal title="Connect an agent (MCP)" onClose={onClose}>
      <p className="mcp-lead">Let AI agents (Claude Code, Claude Desktop, Cursor) read and edit this plan. Needs Node 22+ and the same network as this server.</p>
      {!projectId && <p className="error" role="alert">No project is active. Create or select a project first, then reopen this guide so the agent is pinned to it.</p>}
      <div className="mcp-facts">
        <span><b>Server</b> <code>{url}</code></span>
        {projectId && <span><b>Project</b> <code>{projectId}</code></span>}
        <span className={getWriteKey() ? 'ok' : 'warn'}>{getWriteKey() ? '🔓 Your key is filled in' : '🔒 Replace the key placeholder before running'}</span>
      </div>
      <ol className="mcp-steps">
        <li>
          <h3><span aria-hidden="true">🔌</span> Install the MCP <span className="mcp-tag">Claude Code</span></h3>
          <p>Paste in a terminal. It saves the file to <code>{file}</code> and registers it.</p>
          <CopyBlock text={cmd} label="install command" />
        </li>
        <li>
          <h3><span aria-hidden="true">🧰</span> Add the skills <span className="mcp-tag opt">optional</span></h3>
          <p>Then open Claude Code in your project and run one of:</p>
          <ul className="mcp-skills">
            {SKILLS.map((k) => <li key={k.name}><code>/{k.name}</code> {k.about}</li>)}
          </ul>
          <CopyBlock text={skillCmd} label="skill command" />
        </li>
      </ol>
      <details className="mcp-more">
        <summary>Other clients (Claude Desktop, Cursor)</summary>
        <ol>
          <li><a className="button primary" href="/api/mcp/download" download="pjplanner-mcp.mjs" data-autofocus>Download pjplanner-mcp.mjs</a></li>
          <li>Save it somewhere permanent, for example <code>{file}</code>. Don't move it afterwards, the config points at that path.</li>
          <li>Add this to the client's MCP config with the file's full path, then restart the client:</li>
        </ol>
        <CopyBlock text={config} label="config" />
      </details>
      <details className="mcp-more mcp-remove">
        <summary>Remove the MCP or the skills</summary>
        <p>Run in a terminal. Restart Claude Code afterwards.</p>
        <h4>Remove the MCP</h4>
        <CopyBlock text={removeMcp} label="remove MCP command" />
        <h4>Remove the skills</h4>
        <CopyBlock text={removeSkill} label="remove skill command" />
        <p className="hint">For Claude Desktop or Cursor, delete the <code>pjplanner</code> entry from the client's MCP config instead.</p>
      </details>
      <p className="mcp-note">The write key (<code>WRITE_KEY</code> in the server's <code>.env</code>) lets agents edit the plan. Remove <code>PJPLANNER_API_KEY</code> for read-only access.</p>
    </Modal>
  );
}
