export function htmlTable(
  header: string[],
  rows: string[][],
  options?: {
    tableStyle?: string;
    tbodyStyle?: string;
    tdStyle?: string;
    theadStyle?: string;
    thStyle?: string;
    trHeadStyle?: string;
    trStyle?: string;
  },
): string {
  const config = {
    tableStyle: 'width: 100%; border: 1px solid #000; border-collapse: collapse;',
    tdStyle: 'border: 1px solid #000; padding: 10px;',
    thStyle: 'border: 1px solid #000; padding: 10px;',
    trHeadStyle: 'background-color: #f0f0f0;',
    ...options,
  };
  let table = `<table${config.tableStyle ? ` style="${config.tableStyle}"` : ''}><thead${
    config.theadStyle ? ` style="${config.theadStyle}"` : ''
  }><tr${config.trHeadStyle ? ` style="${config.trHeadStyle}"` : ''}>`;
  for (const head of header) {
    table += `<th${config.thStyle ? ` style="${config.thStyle}"` : ''}>${head}</th>`;
  }
  table += `</tr></thead><tbody${config.tbodyStyle ? ` style="${config.tbodyStyle}"` : ''}>`;
  for (const row of rows) {
    table += `<tr${config.trStyle ? ` style="${config.trStyle}"` : ''}>`;
    for (const cell of row) {
      table += `<td${config.tdStyle ? ` style="${config.tdStyle}"` : ''}>${cell}</td>`;
    }
    table += '</tr>';
  }
  table += '</tbody></table>';
  return table;
}
