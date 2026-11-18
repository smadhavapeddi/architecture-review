// Local test double for DigitalOcean Serverless Inference. NOT used in production.
// Run: node scripts/mock-inference.js, then start the app with INFERENCE_BASE_URL=http://localhost:9999/v1 MODEL_ACCESS_KEY=test-key
const http = require('http');
const REJECT_SCHEMA = process.env.MOCK_REJECT_SCHEMA === '1';
const FENCED = process.env.MOCK_FENCED === '1';
const review = {
  summary: "The setup runs the website and its MySQL database on one Droplet, so a single failure takes the site down and risks data loss. Backups exist but live on the same host.",
  resilience_rating: "fragile",
  strengths: ["Daily snapshots exist", "Cloudflare caching reduces origin load"],
  detected_components: ["WordPress", "MySQL", "Single Droplet", "Cloudflare"],
  assumptions: ["Snapshots are taken from the same Droplet, not copied to another region"],
  findings: [
    { title: "Everything runs on one Droplet", component: "Web and database Droplet", severity: "high",
      why_it_matters: "If this Droplet fails or is overloaded, the website and the database go down together.",
      blast_radius: "The entire site and all content.", fix: "Move the database to Managed MySQL with a standby node and run two web Droplets behind a Regional Load Balancer.",
      do_products: ["Managed Databases", "Regional Load Balancer", "Droplets"] },
    { title: "Database has no off-host backup or standby", component: "MySQL on the same Droplet", severity: "critical",
      why_it_matters: "Disk failure or accidental deletion loses data, and snapshots are crash-consistent only.",
      blast_radius: "All customer data since the last good snapshot.", fix: "Use Managed MySQL with automated backups and point-in-time recovery, plus a standby node.",
      do_products: ["Managed MySQL", "Standby node"] },
    { title: "SSH open to the internet", component: "Droplet firewall", severity: "weird-value",
      why_it_matters: "Exposes the host to brute force attempts.", blast_radius: "Host compromise.", fix: "Restrict SSH with a Cloud Firewall to a bastion or your office IPs.", do_products: ["Cloud Firewalls"] }
  ],
  do_building_blocks: [
    { layer: "Edge", component: "Traffic entry", do_product: "Regional Load Balancer", why: "Spreads traffic across two web Droplets and removes the single entry point." },
    { layer: "Data", component: "MySQL", do_product: "Managed MySQL with standby", why: "Automatic failover and backups without running the database yourself." },
    { layer: "Storage", component: "Uploads", do_product: "Spaces with CDN", why: "Keeps media off the Droplet disk and scales independently." }
  ],
  suggested_topology: [
    { tier: "Edge", items: ["Cloud Firewall", "Regional Load Balancer"] },
    { tier: "Application", items: ["Web Droplet A", "Web Droplet B"] },
    { tier: "Data", items: ["Managed MySQL primary", "Managed MySQL standby"] },
    { tier: "Storage", items: ["Spaces + CDN"] }
  ],
  questions_for_customer: ["What is the acceptable downtime and data loss for this site?"],
  next_steps: ["Move the database to Managed MySQL first", "Add a second web Droplet and a load balancer"]
};
// Failure modes for testing (set as environment variables):
//   MOCK_SLOW=ms        delay before answering
//   MOCK_LENGTH=1       reasoning model that runs out of tokens: empty content, finish_reason "length"
//   MOCK_NO_VISION=1    reject image input with a 400 and a message
//   MOCK_NO_MODEL=1     /v1/models does not list glm-5.3-flash
const SLOW = Number(process.env.MOCK_SLOW || 1200);
const KEY = process.env.MOCK_KEY || 'test-key';
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: 'bad key' });
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      const ids = ['deepseek-v4.1-flash', 'kimi-k3', 'qwen3.8-max'].concat(process.env.MOCK_NO_MODEL === '1' ? [] : ['glm-5.3-flash']);
      return json(200, { object: 'list', data: ids.map(id => ({ id, object: 'model' })) });
    }
    const j = JSON.parse(body || '{}');
    const hasImage = Array.isArray(j.messages?.[1]?.content);
    console.log(`mock: model=${j.model} schema=${!!j.response_format} image=${hasImage} max_tokens=${j.max_tokens}`);
    if (process.env.MOCK_NO_VISION === '1' && hasImage) return json(400, { error: { message: 'This model does not support image input', type: 'invalid_request_error' } });
    if (REJECT_SCHEMA && j.response_format) return json(400, { error: 'response_format not supported' });
    setTimeout(() => {
      if (process.env.MOCK_LENGTH === '1') {
        return json(200, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'Let me think about the diagram step by step...' } }], usage: { total_tokens: 9100 } });
      }
      let content = JSON.stringify(review);
      if (FENCED) content = "Here is the review:\n```json\n" + content + "\n```";
      json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { total_tokens: 4200 } });
    }, SLOW);
  });
}).listen(9999, () => console.log('mock inference on 9999'));
