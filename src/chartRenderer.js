// QuickChart.io integration — generates chart image URLs from Chart.js config

export function renderChart({ chartType, title, data, options = {} }) {
  const config = {
    type: chartType,
    data,
    options: {
      plugins: {
        title: { display: !!title, text: title || '' }
      },
      ...options
    }
  };
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=white`;
}
