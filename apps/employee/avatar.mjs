export async function validatePortrait(file) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('仅支持 5 MiB 以内的 PNG / JPEG / WebP');
  const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
  const jpeg = b[0]===255 && b[1]===216 && b[2]===255;
  const webp = String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP';
  if (!({ 'image/png':png, 'image/jpeg':jpeg, 'image/webp':webp }[file.type])) throw new Error('文件内容与图片类型不符（SVG/HTML 不允许）');
  if (png && b.length>=24) { const view=new DataView(b.buffer); if(view.getUint32(16)*view.getUint32(20)>16000000)throw new Error('图片超过 1600 万像素'); }
}
