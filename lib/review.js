'use strict';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const RATINGS = ['fragile', 'fair', 'solid'];

const SYSTEM_PROMPT = `You are a senior cloud solutions architect reviewing a customer's architecture for resilience, and recommending DigitalOcean building blocks to fix the gaps.

You receive a written description, a diagram image, or both. Review only what you are given. If something is unclear or missing, list it under "assumptions" and "questions_for_customer" instead of guessing silently.

What to look for
- Single points of failure: one Droplet or instance serving a role, a database with no standby or replica, a single load balancer or reverse proxy, one region, one NAT or egress path, one DNS or identity dependency, secrets or state stored on a single machine.
- Data risk: databases co-located with the app, no tested backups or point-in-time recovery, no off-host backups, unreplicated block storage.
- Network and security: public exposure that is not needed, missing private networking, missing firewalls, unrestricted SSH, no stable egress IP where partners allowlist.
- Operations: no health checks, no autoscaling or capacity headroom, no monitoring or alerting, manual deploys, no staging.

DigitalOcean facts you must respect
- A DigitalOcean region is a single data center. There are no availability zones. Protection from a data-center failure means a second region (for example Global Load Balancers, cross-region read replicas, backups copied to Spaces in another region). Never recommend "multi-AZ".
- Building blocks you can recommend: Droplets (Droplet Autoscale Pools, Snapshots, Backups), Regional Load Balancers (HTTP and network, internal load balancers), Global Load Balancers (multi-region), VPC (regional private network, VPC peering), Cloud Firewalls, VPC NAT Gateway (stable egress IP), Reserved IPs, Managed Databases (PostgreSQL, MySQL, Valkey, MongoDB, Kafka, OpenSearch; standby nodes for high availability, read replicas, automated backups, trusted sources, private VPC connections), Spaces object storage with CDN, Volumes block storage, DigitalOcean Kubernetes (DOKS; high-availability control plane option, multiple node pools, node autoscaling), App Platform (managed deploys, multiple instances, autoscaling), Functions, Container Registry, DNS, Monitoring and uptime alerts, Serverless Inference and Dedicated Inference for AI workloads.
- Do not invent product names, SKUs, prices, limits, or SLAs. If you are not sure a feature exists, say "verify in the DigitalOcean docs" in the relevant field.

How to write
- Be specific to this customer's setup. Name the actual component from their description in each finding. No generic advice.
- Order findings from most to least severe. Give at most 8 findings. Use "critical" only when one failure takes the whole service down or loses data with no recovery path.
- For each finding explain what breaks, how far the damage spreads (blast radius), and the concrete fix using DigitalOcean products.
- Add up to 3 genuine strengths if there are any. Do not flatter.
- suggested_topology describes the improved design as tiers from the internet inward (for example Edge, Application, Data, Operations). Each item is a short component name such as "Regional Load Balancer" or "Managed PostgreSQL with standby".
- Plain sentences. No marketing language. No emojis.

Output format
Respond with a single JSON object and nothing else, with exactly these keys:
{
  "summary": string (2 to 3 sentences),
  "resilience_rating": "fragile" | "fair" | "solid",
  "strengths": string[],
  "detected_components": string[],
  "assumptions": string[],
  "findings": [{ "title": string, "component": string, "severity": "critical" | "high" | "medium" | "low", "why_it_matters": string, "blast_radius": string, "fix": string, "do_products": string[] }],
  "do_building_blocks": [{ "layer": string, "component": string, "do_product": string, "why": string }],
  "suggested_topology": [{ "tier": string, "items": string[] }],
  "questions_for_customer": string[],
  "next_steps": string[]
}`;

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'resilience_rating',
    'strengths',
    'detected_components',
    'assumptions',
    'findings',
    'do_building_blocks',
    'suggested_topology',
    'questions_for_customer',
    'next_steps',
  ],
  properties: {
    summary: str,
    resilience_rating: { type: 'string', enum: RATINGS },
    strengths: strArr,
    detected_components: strArr,
    assumptions: strArr,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'component', 'severity', 'why_it_matters', 'blast_radius', 'fix', 'do_products'],
        properties: {
          title: str,
          component: str,
          severity: { type: 'string', enum: SEVERITIES },
          why_it_matters: str,
          blast_radius: str,
          fix: str,
          do_products: strArr,
        },
      },
    },
    do_building_blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['layer', 'component', 'do_product', 'why'],
        properties: { layer: str, component: str, do_product: str, why: str },
      },
    },
    suggested_topology: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tier', 'items'],
        properties: { tier: str, items: strArr },
      },
    },
    questions_for_customer: strArr,
    next_steps: strArr,
  },
};

const text = (v, max = 1200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, maxItems, maxLen) =>
  (Array.isArray(v) ? v : [])
    .map((x) => text(x, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

/**
 * Model output is untrusted: coerce it into the exact shape the UI expects.
 */
function normalizeReview(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sevRank = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .map((f) => {
      const o = f && typeof f === 'object' ? f : {};
      const severity = SEVERITIES.includes(String(o.severity).toLowerCase())
        ? String(o.severity).toLowerCase()
        : 'medium';
      return {
        title: text(o.title, 200),
        component: text(o.component, 160),
        severity,
        why_it_matters: text(o.why_it_matters),
        blast_radius: text(o.blast_radius),
        fix: text(o.fix),
        do_products: list(o.do_products, 8, 80),
      };
    })
    .filter((f) => f.title)
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
    .slice(0, 8);

  const blocks = (Array.isArray(r.do_building_blocks) ? r.do_building_blocks : [])
    .map((b) => {
      const o = b && typeof b === 'object' ? b : {};
      return {
        layer: text(o.layer, 80),
        component: text(o.component, 160),
        do_product: text(o.do_product, 120),
        why: text(o.why, 500),
      };
    })
    .filter((b) => b.do_product)
    .slice(0, 14);

  const topology = (Array.isArray(r.suggested_topology) ? r.suggested_topology : [])
    .map((t) => {
      const o = t && typeof t === 'object' ? t : {};
      return { tier: text(o.tier, 60), items: list(o.items, 8, 80) };
    })
    .filter((t) => t.tier && t.items.length)
    .slice(0, 6);

  const rating = RATINGS.includes(String(r.resilience_rating).toLowerCase())
    ? String(r.resilience_rating).toLowerCase()
    : 'fair';

  return {
    summary: text(r.summary, 900),
    resilience_rating: rating,
    strengths: list(r.strengths, 3, 300),
    detected_components: list(r.detected_components, 20, 100),
    assumptions: list(r.assumptions, 8, 300),
    findings,
    do_building_blocks: blocks,
    suggested_topology: topology,
    questions_for_customer: list(r.questions_for_customer, 8, 300),
    next_steps: list(r.next_steps, 6, 300),
  };
}

/**
 * Pull a JSON object out of model text, tolerating code fences and stray prose.
 */
function extractJson(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(s);
  } catch (_) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { SYSTEM_PROMPT, REVIEW_SCHEMA, normalizeReview, extractJson };
