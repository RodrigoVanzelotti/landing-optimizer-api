/** Quoted fields plus formula neutralization for spreadsheet exports. */
export function csvRow(values: string[]): string {
  return values.map(value => {
    const safe = /^\s*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',') + '\r\n';
}
