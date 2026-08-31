export function buildTrustedClickCommands(boxModel) {
  const points = boxModel?.content;
  if (!Array.isArray(points) || points.length < 8) throw new Error('send_button_box_missing');
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
  ];
}
