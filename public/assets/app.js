'use strict';

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const dropEl = $('drop');
const fileEl = $('file');
const previewEl = $('preview');
const previewImg = $('previewImg');
const previewName = $('previewName');
const descEl = $('desc');
const runBtn = $('run');
const statusEl = $('status');
const outEl = $('out');

let imageDataUrl = null;
let lastReview = null;
let timer = null;

const EXAMPLES = {
  wordpress:
    'A WordPress site on one Droplet in NYC1 with MySQL installed on the same Droplet. Daily Droplet snapshots. Cloudflare sits in front for DNS and caching. SSH is open to the whole internet. Uploads are stored on the Droplet disk.',
  services:
    'Three services (api, worker, web), each on its own Droplet, behind a single Nginx Droplet that acts as the reverse proxy and holds a Reserved IP. PostgreSQL runs on a separate Droplet with a nightly pg_dump copied to Spaces. Redis runs on the api Droplet. All Droplets are in the default VPC in one region. Deploys are done by SSH and a shell script.',
  doks:
    'A DOKS cluster with one node pool of 2 nodes. The main deployment runs a single replica. Ingress goes through one DigitalOcean Load Balancer. The database is a Managed PostgreSQL cluster with one node and no standby. Images are in Container Registry. Application secrets are stored in plain ConfigMaps. There is no monitoring or alerting.',
};

const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

// ---------- Small DOM helper (all model text goes through textContent) ----------
function el(tag, opts = {}, ...kids) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  kids.flat().forEach((k) => k != null && node.append(k));
  return node;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

// ---------- Config and sign out ----------
fetch('/api/config')
  .then((r) => (r.status === 401 ? (location.href = '/login', null) : r.json()))
  .then((cfg) => {
    if (!cfg) return;
    $('modelNote').textContent = `Model: ${cfg.model}`;
    const st = cfg.check && cfg.check.state;
    if (!cfg.keyConfigured || st === 'nokey') {
      setStatus('The model access key is not set on the server yet, so reviews will fail.', true);
    } else if (st === 'badkey') {
      setStatus('The model access key was rejected. Check MODEL_ACCESS_KEY in the app settings.', true);
    } else if (st === 'missing') {
      const hints = cfg.check.hints && cfg.check.hints.length ? ` Models your key can use include: ${cfg.check.hints.join(', ')}.` : '';
      setStatus(`The model "${cfg.model}" is not available for your key. Set MODEL in the app settings.${hints}`, true);
    }
  })
  .catch(() => {});

$('signOut').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// ---------- Image handling ----------
async function toDataUrl(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use a PNG, JPEG, WebP, or GIF image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('That image is over 20 MB. Use a smaller one.');
  const bmp = await createImageBitmap(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL('image/png');
  if (url.length > 3.5 * 1024 * 1024) url = canvas.toDataURL('image/jpeg', 0.88);
  if (url.length > 8.5 * 1024 * 1024) throw new Error('That diagram is too large even after resizing. Crop it and try again.');
  return url;
}

async function setImage(file) {
  try {
    setStatus('');
    imageDataUrl = await toDataUrl(file);
    previewImg.src = imageDataUrl;
    previewName.textContent = file.name || 'Pasted image';
    previewEl.hidden = false;
    dropEl.hidden = true;
  } catch (err) {
    setStatus(err.message || 'Could not read that image.', true);
  }
}

function clearImage() {
  imageDataUrl = null;
  previewImg.removeAttribute('src');
  previewEl.hidden = true;
  dropEl.hidden = false;
  fileEl.value = '';
}

dropEl.addEventListener('click', () => fileEl.click());
dropEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileEl.click();
  }
});
fileEl.addEventListener('change', () => fileEl.files[0] && setImage(fileEl.files[0]));
$('removeImg').addEventListener('click', clearImage);

['dragenter', 'dragover'].forEach((t) =>
  dropEl.addEventListener(t, (e) => {
    e.preventDefault();
    dropEl.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((t) =>
  dropEl.addEventListener(t, (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
  })
);
dropEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setImage(f);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    const f = item.getAsFile();
    if (f) setImage(f);
  }
});

// ---------- Examples ----------
$('examples').addEventListener('click', (e) => {
  const key = e.target && e.target.dataset && e.target.dataset.example;
  if (!key) return;
  descEl.value = EXAMPLES[key];
  descEl.focus();
  setStatus('');
});

// ---------- Run review ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Reviews run as background jobs on the server. Poll until done so no single request stays open long.
async function pollJob(jobId) {
  const deadline = Date.now() + 6 * 60 * 1000;
  let netFails = 0;
  while (Date.now() < deadline) {
    await sleep(2500);
    let r;
    try {
      r = await fetch(`/api/review/${jobId}`, { cache: 'no-store' });
      netFails = 0;
    } catch (_) {
      if (++netFails >= 5) throw new Error('Lost connection to the server while waiting for the review. Try again.');
      continue;
    }
    if (r.status === 401) {
      location.href = '/login';
      throw new Error('Your session has ended. Sign in again.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'The review could not be retrieved. Try again.');
    if (data.status === 'done') return data;
    if (data.status === 'error') {
      const err = new Error(data.error || 'The review failed. Try again.');
      err.detail = data.detail;
      throw err;
    }
  }
  throw new Error('The review is taking too long. Try a smaller diagram or a shorter description.');
}

runBtn.addEventListener('click', async () => {
  const description = descEl.value.trim();
  if (!description && !imageDataUrl) {
    setStatus('Upload a diagram or describe the setup first.', true);
    return;
  }
  runBtn.disabled = true;
  runBtn.textContent = 'Reviewing…';
  const t0 = Date.now();
  setStatus('Reviewing. This usually takes 20 to 60 seconds.');
  timer = setInterval(() => setStatus(`Reviewing. ${Math.round((Date.now() - t0) / 1000)} seconds so far.`), 1000);

  try {
    const r = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, image: imageDataUrl }),
    });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    const started = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(started.error || 'The review could not start. Try again.');

    let data;
    if (started.review) data = started; // a server that answers directly
    else if (started.jobId) data = await pollJob(started.jobId);
    else throw new Error('The server sent an unexpected response. Refresh the page (Ctrl+Shift+R) and try again.');
    if (!data || !data.review || !Array.isArray(data.review.findings)) {
      throw new Error('The review came back incomplete. Refresh the page (Ctrl+Shift+R) and try again.');
    }
    lastReview = data;
    render(data);
    setStatus('');
    if (window.innerWidth < 960) outEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus((err.message || 'The review failed. Try again.') + (err.detail ? ` Details: ${err.detail}` : ''), true);
  } finally {
    clearInterval(timer);
    runBtn.disabled = false;
    runBtn.textContent = 'Review architecture';
  }
});

// ---------- Render ----------
function section(title, ...kids) {
  return el('section', { class: 'sec' }, el('h2', { text: title }), ...kids);
}

function bulletList(items) {
  return el('ul', { class: 'plain-list' }, items.map((t) => el('li', { text: t })));
}

function render({ review, model, tookMs }) {
  outEl.classList.remove('ready');
  outEl.replaceChildren();

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  review.findings.forEach((f) => counts[f.severity]++);

  // Header: rating, summary, severity strip, actions
  const meter = el(
    'div',
    { class: 'meter', attrs: { role: 'img', 'aria-label': `Resilience: ${review.resilience_rating}` } },
    ['fragile', 'fair', 'solid'].map((r) =>
      el('span', { class: r === review.resilience_rating ? `on ${r}` : '', text: r[0].toUpperCase() + r.slice(1) })
    )
  );
  const head = el(
    'div',
    { class: 'report-head' },
    el('div', { class: 'rating' }, el('span', { class: 'rating-label', text: 'Resilience' }), meter),
    el('p', { class: 'summary', text: review.summary })
  );

  if (review.findings.length) {
    const bar = el('div', { class: 'strip-bar', attrs: { 'aria-hidden': 'true' } });
    const legend = el('div', { class: 'strip-legend' });
    ['critical', 'high', 'medium', 'low'].forEach((s) => {
      if (!counts[s]) return;
      const seg = el('i', { class: s });
      seg.style.flexGrow = String(counts[s]);
      bar.append(seg);
      legend.append(el('span', {}, el('span', { class: `dot ${s}` }), el('b', { text: String(counts[s]) }), ` ${SEV_LABEL[s].toLowerCase()}`));
    });
    head.append(el('div', { class: 'strip' }, bar, legend));
  }

  const actions = el('div', { class: 'actions' });
  const copyBtn = el('button', { class: 'secondary', text: 'Copy as Markdown', attrs: { type: 'button' } });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(review));
      copyBtn.textContent = 'Copied';
    } catch (_) {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy as Markdown'), 2000);
  });
  const printBtn = el('button', { class: 'secondary', text: 'Print or save as PDF', attrs: { type: 'button' } });
  printBtn.addEventListener('click', () => window.print());
  actions.append(copyBtn, printBtn);
  head.append(actions);
  outEl.append(head);

  // Findings
  const findingsSec = section(`Single points of failure and risks (${review.findings.length})`);
  if (!review.findings.length) {
    findingsSec.append(el('p', { class: 'sub', text: 'No significant single points of failure found in what was provided.' }));
  }
  review.findings.forEach((f) => {
    const art = el(
      'article',
      { class: `finding ${f.severity}` },
      el('div', { class: 'f-top' }, el('span', { class: `sev ${f.severity}`, text: SEV_LABEL[f.severity] }), f.component ? el('span', { text: f.component }) : null),
      el('h3', { text: f.title })
    );
    const line = (k, v) => v && art.append(el('p', { class: 'f-line' }, el('span', { class: 'k', text: k }), v));
    line('What breaks', f.why_it_matters);
    line('How far it spreads', f.blast_radius);
    line('Fix', f.fix);
    if (f.do_products.length) art.append(el('ul', { class: 'tags' }, f.do_products.map((p) => el('li', { text: p }))));
    findingsSec.append(art);
  });
  outEl.append(findingsSec);

  if (review.strengths.length) outEl.append(section('Already in good shape', bulletList(review.strengths)));

  // Building blocks
  if (review.do_building_blocks.length) {
    const table = el(
      'div',
      { class: 'blocks' },
      el('div', { class: 'b-row head' }, el('span', { text: 'Layer' }), el('span', { text: 'Component' }), el('span', { text: 'DigitalOcean product' }), el('span', { text: 'Why' }))
    );
    review.do_building_blocks.forEach((b) =>
      table.append(
        el(
          'div',
          { class: 'b-row' },
          el('span', { class: 'b-layer', text: b.layer }),
          el('span', { text: b.component }),
          el('span', { class: 'b-product', text: b.do_product }),
          el('span', { class: 'b-why', text: b.why })
        )
      )
    );
    outEl.append(section('Suggested DigitalOcean building blocks', table));
  }

  // Suggested topology
  if (review.suggested_topology.length) {
    const vpc = el('div', { class: 'vpc' }, el('span', { class: 'vpc-tag', text: 'VPC' }));
    review.suggested_topology.forEach((t) =>
      vpc.append(el('div', { class: 'tier' }, el('div', { class: 'tier-name', text: t.tier }), el('div', { class: 'tier-items' }, t.items.map((i) => el('span', { class: 'node', text: i })))))
    );
    outEl.append(
      section('Suggested topology', el('div', { class: 'topo' }, el('div', { class: 'topo-net', text: 'Internet' }), vpc))
    );
  }

  if (review.assumptions.length) outEl.append(section('Assumptions made', bulletList(review.assumptions)));
  if (review.questions_for_customer.length) outEl.append(section('Questions for the customer', bulletList(review.questions_for_customer)));
  if (review.next_steps.length) outEl.append(section('Suggested next steps', bulletList(review.next_steps)));

  const secs = Math.max(1, Math.round(tookMs / 1000));
  outEl.append(
    el('p', {
      class: 'foot-note',
      text: `AI-generated review by ${model} on DigitalOcean Serverless Inference, in ${secs} ${secs === 1 ? 'second' : 'seconds'}. Verify product details in the DigitalOcean docs before sharing with a customer.`,
    })
  );

  requestAnimationFrame(() => requestAnimationFrame(() => outEl.classList.add('ready')));
}

// ---------- Markdown export ----------
function toMarkdown(r) {
  const L = [];
  L.push('# Architecture review', '', r.summary, '', `**Resilience:** ${r.resilience_rating}`, '');
  if (r.strengths.length) L.push('## Already in good shape', ...r.strengths.map((s) => `- ${s}`), '');
  L.push('## Single points of failure and risks', '');
  if (!r.findings.length) L.push('None found in what was provided.', '');
  r.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.title} (${SEV_LABEL[f.severity]})`);
    if (f.component) L.push(`Component: ${f.component}`);
    L.push('', `**What breaks:** ${f.why_it_matters}`, `**How far it spreads:** ${f.blast_radius}`, `**Fix:** ${f.fix}`);
    if (f.do_products.length) L.push(`**DigitalOcean products:** ${f.do_products.join(', ')}`);
    L.push('');
  });
  if (r.do_building_blocks.length) {
    L.push('## Suggested DigitalOcean building blocks', '', '| Layer | Component | DigitalOcean product | Why |', '|---|---|---|---|');
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    r.do_building_blocks.forEach((b) => L.push(`| ${cell(b.layer)} | ${cell(b.component)} | ${cell(b.do_product)} | ${cell(b.why)} |`));
    L.push('');
  }
  if (r.suggested_topology.length) {
    L.push('## Suggested topology', '');
    r.suggested_topology.forEach((t) => L.push(`- **${t.tier}:** ${t.items.join(', ')}`));
    L.push('');
  }
  if (r.assumptions.length) L.push('## Assumptions made', ...r.assumptions.map((s) => `- ${s}`), '');
  if (r.questions_for_customer.length) L.push('## Questions for the customer', ...r.questions_for_customer.map((s) => `- ${s}`), '');
  if (r.next_steps.length) L.push('## Suggested next steps', ...r.next_steps.map((s) => `- ${s}`), '');
  L.push('_AI-generated. Verify product details in the DigitalOcean docs before sharing._');
  return L.join('\n');
}
