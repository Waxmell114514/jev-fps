/** DOM side of the HUD: scoreboard, telemetry panel, banners. */

import { HOLD, TEMPO_LEVELS } from '../shared/brain.js';
import type { HealthInfo } from '../shared/protocol.js';
import { estimateCostUsd } from '../shared/typesafe.js';
import type { World } from './engine/world.js';
import { MODES } from './engine/world.js';
import type { JevPilot } from './pilot.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export class Hud {
  private points = el('s-points');
  private kills = el('s-kills');
  private acc = el('s-acc');
  private ttk = el('s-ttk');
  private ff = el('s-ff');
  private clock = el('s-clock');
  private blurb = el('mode-blurb');
  private banner = el('banner');

  private badge = el('brain-badge');
  private brainModel = el('brain-model');
  private endpoint = el('p-endpoint');
  private model = el('p-model');
  private calls = el('p-calls');
  private latency = el('p-latency');
  private latencyP = el('p-latency-p');
  private stale = el('p-stale');
  private tokens = el('p-tokens');
  private cost = el('p-cost');

  private choice = el('p-choice');
  private conf = el('p-conf');
  private fallback = el('p-fallback');

  private engageFill = el('p-engage-fill');
  private engageLabel = el('p-engage-label');
  private engage = el('p-engage');
  private verdict = el('p-verdict');
  private withheld = el('p-withheld');

  private tempoFill = el('p-tempo-fill');
  private tempo = el('p-tempo');
  private slew = el('p-slew');

  private logBox = el('p-log');
  private json = el('p-json');
  private spark = el<HTMLCanvasElement>('spark');

  jsonTab: 'request' | 'response' = 'request';
  private logLen = 0;

  setLink(info: HealthInfo, mode: 'server' | 'local'): void {
    const live = info.source === 'jev';
    this.badge.textContent = live ? 'JEV LIVE' : 'SIMULATOR';
    this.badge.className = `badge ${live ? 'live' : 'sim'}`;
    this.brainModel.textContent = info.model;
    this.model.textContent = info.model;
    this.endpoint.textContent = live
      ? 'POST /api/decide -> api.typesafe.ai/v1/systemone'
      : mode === 'server'
        ? 'POST /api/decide -> local simulator'
        : 'in-page simulator';
  }

  setMode(mode: keyof typeof MODES): void {
    this.blurb.textContent = MODES[mode].blurb;
  }

  updateScore(world: World): void {
    this.points.textContent = String(world.stats.points);
    this.kills.textContent = String(world.stats.kills);
    this.acc.textContent = `${world.accuracyPct()}%`;
    this.ttk.textContent = `${world.avgTtkMs()} ms`;
    this.ff.textContent = String(world.stats.friendlyFire);
    this.clock.textContent = (world.timeLeftMs / 1000).toFixed(1);
  }

  updatePanel(pilot: JevPilot): void {
    const d = pilot.decision;
    this.calls.textContent = `${pilot.callsLanded} landed / ${pilot.callsStarted} sent`;
    this.tokens.textContent = pilot.inputTokens.toLocaleString();
    this.cost.textContent = `$${estimateCostUsd({ input_tokens: pilot.inputTokens, output_tokens: 0 }).toFixed(6)}`;
    this.fallback.textContent = String(pilot.fallbacks);
    this.withheld.textContent = String(pilot.withheld);
    this.slew.textContent = `${Math.round(pilot.slewRate)} deg/s`;
    const stalePct = pilot.callsLanded ? Math.round((pilot.staleCalls / pilot.callsLanded) * 100) : 0;
    this.stale.textContent = `${pilot.staleCalls}  (${stalePct}%)`;

    if (!d) {
      this.latency.textContent = '-';
      this.latencyP.textContent = '-';
      return;
    }

    this.latency.textContent = `${Math.round(d.latencyMs)} ms`;
    this.latencyP.textContent = `${pilot.latencyPercentile(0.5)} / ${pilot.latencyPercentile(0.95)} ms`;

    // Choice distribution.
    const entries = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const top = entries[0]?.[0];
    this.choice.replaceChildren(
      ...entries.map(([id, p]) => {
        const bar = document.createElement('div');
        bar.className = `bar${id === top ? ' top' : ''}${id === HOLD ? ' hold' : ''}`;
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(p * 100)}%`;
        const label = document.createElement('span');
        const name = document.createElement('em');
        name.style.fontStyle = 'normal';
        name.textContent = id === HOLD ? 'hold fire' : `contact ${id}`;
        const value = document.createElement('b');
        value.textContent = `${(p * 100).toFixed(1)}%`;
        label.append(name, value);
        bar.append(fill, label);
        return bar;
      }),
    );
    this.conf.textContent = `${d.confidence.toFixed(3)}${d.fallback ? '  (code fallback)' : ''}`;

    // Engage noul.
    this.engageFill.style.width = `${Math.round(d.engage * 100)}%`;
    this.engageLabel.textContent = d.engageTargetId ? `contact ${d.engageTargetId}` : 'no contact';
    this.engage.textContent = d.engage.toFixed(3);
    this.verdict.textContent = d.fire.toUpperCase();
    this.verdict.className = `chip ${d.fire}`;

    // Tempo score.
    const levels = TEMPO_LEVELS.length - 1;
    this.tempoFill.style.width = `${Math.round((d.tempo / levels) * 100)}%`;
    this.tempo.textContent = `${d.tempo.toFixed(2)} / ${levels}  ${d.tempoLabel}`;

    if (pilot.log.length !== this.logLen) {
      this.logLen = pilot.log.length;
      this.logBox.replaceChildren(
        ...pilot.log.slice(-24).reverse().map((line) => {
          const div = document.createElement('div');
          if (/withheld|held fire|unsure|fallback|failed/.test(line)) div.className = 'hi';
          div.textContent = line;
          return div;
        }),
      );
    }

    const payload = this.jsonTab === 'request' ? pilot.lastRequest : pilot.lastResponse;
    if (payload) this.json.textContent = JSON.stringify(payload, null, 1);
  }

  drawSpark(pilot: JevPilot): void {
    const ctx = this.spark.getContext('2d');
    if (!ctx) return;
    const w = this.spark.width;
    const h = this.spark.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#080d14';
    ctx.fillRect(0, 0, w, h);

    const data = pilot.history.slice(-60);
    const max = Math.max(500, ...data.map((d) => d.latencyMs));

    // 500 ms line: the top of Jev's published latency band.
    const y500 = h - (500 / max) * h;
    ctx.strokeStyle = '#23303f';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y500);
    ctx.lineTo(w, y500);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#3a4a5c';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('500 ms', 4, Math.max(11, y500 - 3));

    const bw = w / Math.max(20, data.length);
    data.forEach((d, i) => {
      const bh = Math.max(1, (d.latencyMs / max) * (h - 4));
      ctx.fillStyle = d.stale ? '#ff5f45' : d.source === 'jev' ? '#b98cff' : '#4a7c9b';
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
    });
  }

  showBanner(title: string, sub: string, rows?: [string, string][]): void {
    this.banner.classList.remove('hidden');
    const h2 = document.createElement('h2');
    h2.textContent = title;
    const p = document.createElement('p');
    p.textContent = sub;
    const nodes: HTMLElement[] = [h2, p];
    if (rows?.length) {
      const table = document.createElement('table');
      for (const [k, v] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = k;
        const td2 = document.createElement('td');
        td2.className = 'v';
        td2.textContent = v;
        tr.append(td1, td2);
        table.append(tr);
      }
      nodes.push(table);
    }
    this.banner.replaceChildren(...nodes);
  }

  hideBanner(): void {
    this.banner.classList.add('hidden');
  }
}
