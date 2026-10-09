// Make a sent email safe to LOOK at.
//
// Extracted from api/market-history.js when api/cakemail-templates.js needed the same guard for
// its template preview. Deliberately ONE copy: the hazard below is not obvious, and a second
// implementation that forgot the <base> line or matched only quoted hrefs would be a preview
// that silently unsubscribes people.
//
// sandbox="" on the iframe stops scripts, forms and top-level navigation — but it does NOT stop
// a click navigating the iframe itself. Every blast ends in a one-click Unsubscribe, and that
// URL unsubscribes on GET: previewing a blast in the panel could quietly opt a real contact out
// of a real list (Vhea, 2026-09-08). Every tracked link in the body has the same shape, so a
// stray click could also register a click against the campaign and move the numbers Market
// History reports.
//
// Defanged ON THE SERVER rather than in the browser, so a live href never reaches the page at
// all. The address is kept in data-href so it is still inspectable, and the anchors keep their
// styling — the point of the preview is to see what was sent, underlines included.
export function defangHtml(html) {
  const inert =
    '<style>a{pointer-events:none!important;cursor:default!important}' +
    'form{pointer-events:none!important}</style>';
  const body = String(html)
    // href on anchors -> data-href. Handles quoted and bare values.
    .replace(/(<a\b[^>]*?)\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1 data-href=$2')
    // and the same for a form that would post somewhere
    .replace(/(<form\b[^>]*?)\saction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1 data-action=$2')
    // <base> would re-point every relative URL; nothing in a preview needs one
    .replace(/<base\b[^>]*>/gi, '');
  return inert + body;
}
