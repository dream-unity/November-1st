/** Remove the static-host gateway before compiling the complete application. */
export function stripPagesEntry(html) {
  for (const part of ['head', 'body']) {
    const start = `<!-- du:pages-entry-${part}:start -->`;
    const end = `<!-- du:pages-entry-${part}:end -->`;
    const starts = html.split(start).length - 1;
    const ends = html.split(end).length - 1;
    if (!starts && !ends) continue;
    if (starts !== 1 || ends !== 1 || html.indexOf(end) < html.indexOf(start)) {
      throw new Error(`Invalid GitHub Pages entry markers: ${part}`);
    }
    html =
      html.slice(0, html.indexOf(start)) +
      html.slice(html.indexOf(end) + end.length);
  }
  return html;
}
