// Interleaved TIFF samples in, linear Rec.2020 with straight alpha out, one row band per dispatch.

struct Params {
  width: u32,
  height: u32,
  channels: u32,
  bytes: u32,        // per sample
  bits: u32,         // per sample; zero for float
  orientation: u32,  // TIFF orientation tag, 1 to 8
  photometric: u32,  // 0 white is zero, 1 black is zero, 2 RGB
  alpha: u32,        // 1 when the extra sample is associated (premultiplied) alpha
  rowBytes: u32,
  startRow: u32,     // first image row in this band
  rows: u32,         // rows in this band
  bigEndian: u32,
  matrix: mat3x3f,
}

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> curves: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var output: texture_storage_2d<rgba16float, write>;

// One sample at a byte offset, normalized to 0..1 for integers and left as is for floats.
fn sample(offset: u32) -> f32 {
  var word = source[offset / 4u];
  if params.bigEndian == 1u {
    if params.bytes == 2u { word = ((word & 0x00ff00ffu) << 8u) | ((word & 0xff00ff00u) >> 8u); }
    if params.bytes == 4u { word = (word << 24u) | ((word & 0xff00u) << 8u) | ((word >> 8u) & 0xff00u) | (word >> 24u); }
  }
  if params.bits == 0u { return bitcast<f32>(word); }
  var value = word;
  if params.bytes < 4u { value = (word >> ((offset % 4u) * 8u)) & ((1u << (params.bytes * 8u)) - 1u); }
  return f32(value) / (exp2(f32(params.bits)) - 1.0);
}

// Transfer curve over 0..1; samples outside keep their distance, so HDR and negative values pass through.
fn transfer(value: f32, channel: u32) -> f32 {
  let last = arrayLength(&curves) / 3u - 1u;
  let bounded = clamp(value, 0.0, 1.0);
  let position = bounded * f32(last);
  let low = min(u32(position), last - 1u);
  let base = channel * (last + 1u) + low;
  return mix(curves[base], curves[base + 1u], position - f32(low)) + (value - bounded);
}

// Where a stored pixel lands after the orientation tag.
fn oriented(p: vec2u) -> vec2u {
  let w = params.width - 1u;
  let h = params.height - 1u;
  switch params.orientation {
    case 2u: { return vec2u(w - p.x, p.y); }
    case 3u: { return vec2u(w - p.x, h - p.y); }
    case 4u: { return vec2u(p.x, h - p.y); }
    case 5u: { return p.yx; }
    case 6u: { return vec2u(h - p.y, p.x); }
    case 7u: { return vec2u(h - p.y, w - p.x); }
    case 8u: { return vec2u(p.y, w - p.x); }
    default: { return p; }
  }
}

@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= params.width || id.y >= params.rows { return; }
  let offset = id.y * params.rowBytes + id.x * params.channels * params.bytes;

  // Gray replicates its single sample; RGB reads three.
  var rgb = vec3f(sample(offset));
  var colors = 1u;
  if params.photometric == 2u {
    colors = 3u;
    rgb = vec3f(rgb.r, sample(offset + params.bytes), sample(offset + 2u * params.bytes));
  }
  var alpha = 1.0;
  if params.channels > colors { alpha = sample(offset + colors * params.bytes); }
  if params.photometric == 0u { rgb = 1.0 - rgb; }
  if params.alpha == 1u { rgb /= max(alpha, 0.000001); }

  let linear = vec3f(transfer(rgb.r, 0u), transfer(rgb.g, 1u), transfer(rgb.b, 2u));
  textureStore(output, oriented(vec2u(id.x, id.y + params.startRow)), vec4f(params.matrix * linear, alpha));
}
