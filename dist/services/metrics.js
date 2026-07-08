export function parseMetricsFromText(text, parameter) {
    const out = {};
    const lcp = text.match(/lcp[^0-9]*(\d+(?:\.\d+)?)\s*(ms|s)?/i);
    if (lcp) {
        let v = parseFloat(lcp[1]);
        if (lcp[2]?.toLowerCase() === 's')
            v *= 1000;
        out.lcpMs = v;
    }
    const inp = text.match(/inp[^0-9]*(\d+(?:\.\d+)?)\s*ms/i);
    if (inp)
        out.inpMs = parseFloat(inp[1]);
    const cls = text.match(/cls[^0-9]*(\d+(?:\.\d+)?)/i);
    if (cls)
        out.cls = parseFloat(cls[1]);
    const ttfb = text.match(/ttfb[^0-9]*(\d+(?:\.\d+)?)\s*ms/i);
    if (ttfb)
        out.ttfbMs = parseFloat(ttfb[1]);
    const kb = text.match(/(\d+(?:\.\d+)?)\s*kb/i);
    if (kb) {
        if (parameter === 'load_network_speed')
            out.pageWeightKb = parseFloat(kb[1]);
        else
            out.largestResourceKb = parseFloat(kb[1]);
    }
    const reqs = text.match(/(\d+)\s*requests?/i);
    if (reqs)
        out.requestCount = parseInt(reqs[1], 10);
    const nodes = text.match(/(\d+)\s*nodes?/i);
    if (nodes)
        out.domNodeCount = parseInt(nodes[1], 10);
    if (/fouc|flash of unstyled/i.test(text))
        out.foucDetected = true;
    return out;
}
export function extractFromSuggestion(s) {
    const merged = {};
    const texts = [];
    if (s.verification?.finding)
        texts.push(s.verification.finding);
    for (const step of s.diagram?.before ?? [])
        if (step.metric)
            texts.push(step.metric);
    for (const step of s.diagram?.after ?? [])
        if (step.metric)
            texts.push(step.metric);
    for (const t of texts) {
        Object.assign(merged, parseMetricsFromText(t, s.parameter));
    }
    return merged;
}
export function urlHash(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++)
        h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16).slice(0, 12);
}
