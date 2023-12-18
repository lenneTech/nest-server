export function htmlTable(
  header: string[],
  rows: string[][],
  options?: {
    tableStyle?: string;
    theadStyle?: string;
    trHeadStyle?: string;
    thStyle?: string;
    tbodyStyle?: string;
    trStyle?: string;
    tdStyle?: string;
  },
): string {
  const config = {
    tableStyle: 'width: 100%; border: 1px solid #000; border-collapse: collapse;',
    trHeadStyle: 'background-color: #f0f0f0;',
    thStyle: 'border: 1px solid #000; padding: 10px;',
    tcStyle: 'border: 1px solid #000; padding: 10px;',
    ...options,
  };
  let table = `<table style="${config.tableStyle}"><thead style="${config.theadStyle}"><tr style="${config.trHeadStyle}">`;
  for (const head of header) {
    table += `<th style="${config.thStyle}">${head}</th>`;
  }
  table += '</tr></thead><tbody style="${config.tbodyStyle}">';
  for (const row of rows) {
    table += `<tr style="${config.trStyle}">`;
    for (const cell of row) {
      table += `<td style="${config.tdStyle}">${cell}</td>`;
    }
    table += '</tr>';
  }
  table += '</tbody></table>';
  return table;
}
