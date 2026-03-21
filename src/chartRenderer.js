// QuickChart.io integration — generates chart image URLs from Chart.js config

// Professional color palettes
const PALETTES = {
  vibrant: ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#a855f7'],
  cool: ['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#06b6d4', '#14b8a6', '#10b981', '#22d3ee', '#818cf8', '#c084fc'],
  warm: ['#f43f5e', '#f97316', '#f59e0b', '#ef4444', '#ec4899', '#e11d48', '#fb923c', '#fbbf24', '#f472b6', '#fb7185'],
  earth: ['#78716c', '#92400e', '#065f46', '#1e40af', '#7c2d12', '#164e63', '#713f12', '#365314', '#4c1d95', '#831843'],
  pastel: ['#93c5fd', '#c4b5fd', '#fda4af', '#fdba74', '#86efac', '#a5f3fc', '#f9a8d4', '#fcd34d', '#bef264', '#d8b4fe']
};

function getPalette(type) {
  if (type === 'pie' || type === 'doughnut' || type === 'polarArea') return PALETTES.vibrant;
  return PALETTES.vibrant;
}

function applyDatasetStyling(data, chartType) {
  const palette = getPalette(chartType);
  const datasets = data.datasets || [];

  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i];
    const color = palette[i % palette.length];

    if (chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea') {
      if (!ds.backgroundColor) ds.backgroundColor = palette.slice(0, (ds.data || []).length);
      if (!ds.borderColor) ds.borderColor = '#fff';
      if (ds.borderWidth === undefined) ds.borderWidth = 2;
    } else if (chartType === 'line' || chartType === 'area') {
      if (!ds.borderColor) ds.borderColor = color;
      if (!ds.backgroundColor) ds.backgroundColor = color + '33';
      if (ds.borderWidth === undefined) ds.borderWidth = 2.5;
      if (ds.pointRadius === undefined) ds.pointRadius = 3;
      if (ds.pointBackgroundColor === undefined) ds.pointBackgroundColor = color;
      if (ds.tension === undefined) ds.tension = 0.3;
      if (chartType === 'area' && ds.fill === undefined) ds.fill = true;
    } else if (chartType === 'bar') {
      if (!ds.backgroundColor) ds.backgroundColor = color + 'cc';
      if (!ds.borderColor) ds.borderColor = color;
      if (ds.borderWidth === undefined) ds.borderWidth = 1;
      if (ds.borderRadius === undefined) ds.borderRadius = 4;
    } else if (chartType === 'radar') {
      if (!ds.borderColor) ds.borderColor = color;
      if (!ds.backgroundColor) ds.backgroundColor = color + '33';
      if (ds.borderWidth === undefined) ds.borderWidth = 2;
      if (ds.pointBackgroundColor === undefined) ds.pointBackgroundColor = color;
    } else if (chartType === 'scatter' || chartType === 'bubble') {
      if (!ds.backgroundColor) ds.backgroundColor = color + '99';
      if (!ds.borderColor) ds.borderColor = color;
    } else {
      if (!ds.backgroundColor) ds.backgroundColor = color + 'cc';
      if (!ds.borderColor) ds.borderColor = color;
    }
  }
  return data;
}

export function renderChart({ chartType, title, data, options = {} }) {
  // Handle area as line with fill
  let type = chartType;
  if (type === 'area') {
    type = 'line';
    for (const ds of (data.datasets || [])) { ds.fill = true; }
  }

  const styledData = applyDatasetStyling({ ...data }, chartType);

  const config = {
    type,
    data: styledData,
    options: {
      plugins: {
        title: {
          display: !!title,
          text: title || '',
          font: { size: 16, weight: 'bold' },
          padding: { bottom: 12 }
        },
        legend: {
          display: (styledData.datasets || []).length > 1 || type === 'pie' || type === 'doughnut' || type === 'polarArea',
          position: 'bottom',
          labels: { padding: 16, usePointStyle: true, font: { size: 11 } }
        },
        datalabels: {
          display: type === 'pie' || type === 'doughnut',
          color: '#fff',
          font: { weight: 'bold', size: 11 },
          formatter: (val, ctx) => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
            const pct = Math.round((val / total) * 100);
            return pct > 5 ? pct + '%' : '';
          }
        }
      },
      layout: { padding: { top: 8, bottom: 8, left: 8, right: 8 } },
      ...options
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=%23ffffff`;
}
