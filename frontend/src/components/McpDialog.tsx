import { useEffect, useRef, useState } from 'react';
import { getWriteKey } from '../api';
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

export function McpDialog({ onClose }: { onClose: () => void }) {
  // Address and key come from the server so the command uses its LAN IP instead of the browser's localhost.
  const [info, setInfo] = useState<{ url: string } | null>(null);
  useEffect(() => {
    fetch('/api/mcp/info').then((r) => r.json()).then(setInfo).catch(() => setInfo({ url: window.location.origin }));
  }, []);
  const url = info?.url ?? window.location.origin;
  // The server never reveals the key: use the one entered in the header lock, else a placeholder to fill in.
  const key = getWriteKey() || '<WRITE_KEY from .env>';
  const dir = '~/.pjplanner';
  const file = `${dir}/pjplanner-mcp.mjs`;
  const add = `claude mcp add pjplanner -e PJPLANNER_URL=${url} -e PJPLANNER_API_KEY=${key} -- node ${file}`;
  // One paste: fetch the file into a fixed folder, then register it, so nobody has to place it by hand.
  const cmd = `mkdir -p ${dir} && curl -fsSL ${url}/api/mcp/download -o ${file} && ${add}`;
  // Optional skill: teaches Claude Code to map the current project into this diagram.
  const skillDir = '~/.claude/skills/pjplanner-map';
  const skillCmd = `mkdir -p ${skillDir} && curl -fsSL ${url}/api/mcp/skill -o ${skillDir}/SKILL.md`;
  const removeMcp = `claude mcp remove pjplanner && rm -rf ${dir}`;
  const removeSkill = `rm -rf ${skillDir}`;
  const config = JSON.stringify({ mcpServers: { pjplanner: { command: 'node', args: ['<full path to pjplanner-mcp.mjs>'], env: { PJPLANNER_URL: url, PJPLANNER_API_KEY: key } } } }, null, 2);
  return (
    <Modal title="Connect an agent (MCP)" onClose={onClose}>
      <p className="mcp-lead">Let AI agents (Claude Code, Claude Desktop, Cursor) read and edit this plan. Needs Node 22+ and the same network as this server.</p>
      <div className="mcp-facts">
        <span><b>Server</b> <code>{url}</code></span>
        <span className={getWriteKey() ? 'ok' : 'warn'}>{getWriteKey() ? '🔓 Your key is filled in' : '🔒 Replace the key placeholder before running'}</span>
      </div>
      <ol className="mcp-steps">
        <li>
          <h3><span aria-hidden="true">🔌</span> Install the MCP <span className="mcp-tag">Claude Code</span></h3>
          <p>Paste in a terminal. It saves the file to <code>{file}</code> and registers it.</p>
          <CopyBlock text={cmd} label="install command" />
        </li>
        <li>
          <h3><span aria-hidden="true">🗺️</span> Add the mapping skill <span className="mcp-tag opt">optional</span></h3>
          <p>Then open Claude Code in your project and run <code>/pjplanner-map</code>. It proposes logical modules and dependencies, and creates them here once you approve.</p>
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
        <summary>Remove the MCP or the skill</summary>
        <p>Run in a terminal. Restart Claude Code afterwards.</p>
        <h4>Remove the MCP</h4>
        <CopyBlock text={removeMcp} label="remove MCP command" />
        <h4>Remove the skill</h4>
        <CopyBlock text={removeSkill} label="remove skill command" />
        <p className="hint">For Claude Desktop or Cursor, delete the <code>pjplanner</code> entry from the client's MCP config instead.</p>
      </details>
      <p className="mcp-note">The write key (<code>WRITE_KEY</code> in the server's <code>.env</code>) lets agents edit the plan. Remove <code>PJPLANNER_API_KEY</code> for read-only access.</p>
    </Modal>
  );
}
