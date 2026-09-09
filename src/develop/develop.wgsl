struct Sensor {
  black: vec4f,
  cfa: vec4u,
  white: f32,
  flip: u32,
  mosaic: u32,
}
struct Calibration {
  gains: vec3f,
  exposure: f32,
  matrix: mat3x3f,
}
struct Vignette {
  coefficients: vec4f,
  origin: vec2f,
  step: vec2f,
  last: f32,
}
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> sensor: Sensor;
@group(0) @binding(2) var<uniform> calibration: Calibration;
@group(0) @binding(3) var<uniform> vignette: Vignette;

fn channel(p: vec2i) -> u32 {
  return sensor.cfa[(p.y & 1) * 2 + (p.x & 1)];
}

fn sample(p: vec2i) -> f32 {
  let size = vec2i(textureDimensions(source));
  // Reflect at the border without changing CFA parity.
  let q = min(abs(p), 2 * (size - 1) - p);
  let c = channel(q);
  let value = f32(textureLoad(source, q, 0).r);
  let gain = calibration.gains[select(c, 1u, c == 3u)];
  return max(value - sensor.black[c], 0.0) / (sensor.white - sensor.black[c]) * gain;
}

// Malvar, He and Cutler, ICASSP 2004, Fig. 2: gradient-corrected 5x5 Bayer filters.
fn demosaic(p: vec2i) -> vec3f {
  let center = sample(p);
  let horizontal = sample(p + vec2i(-1, 0)) + sample(p + vec2i(1, 0));
  let vertical = sample(p + vec2i(0, -1)) + sample(p + vec2i(0, 1));
  let horizontal2 = sample(p + vec2i(-2, 0)) + sample(p + vec2i(2, 0));
  let vertical2 = sample(p + vec2i(0, -2)) + sample(p + vec2i(0, 2));
  let diagonal = sample(p + vec2i(-1, -1)) + sample(p + vec2i(1, -1))
    + sample(p + vec2i(-1, 1)) + sample(p + vec2i(1, 1));
  let c = channel(p);
  if (c == 0u || c == 2u) {
    let green = (4.0 * center + 2.0 * (horizontal + vertical) - horizontal2 - vertical2) / 8.0;
    let opposite = (6.0 * center + 2.0 * diagonal - 1.5 * (horizontal2 + vertical2)) / 8.0;
    return select(vec3f(opposite, green, center), vec3f(center, green, opposite), c == 0u);
  }
  let across = (5.0 * center + 4.0 * horizontal - horizontal2 - diagonal + 0.5 * vertical2) / 8.0;
  let along = (5.0 * center + 4.0 * vertical - vertical2 - diagonal + 0.5 * horizontal2) / 8.0;
  return select(vec3f(along, center, across), vec3f(across, center, along), channel(p + vec2i(1, 0)) == 0u);
}

@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  var p = vec2i(position.xy);
  if ((sensor.flip & 4u) != 0u) { p = p.yx; }
  if ((sensor.flip & 2u) != 0u) { p.y = size.y - 1 - p.y; }
  if ((sensor.flip & 1u) != 0u) { p.x = size.x - 1 - p.x; }
  var camera: vec3f;
  if (sensor.mosaic != 0u) {
    camera = demosaic(p);
  } else {
    let value = vec3f(textureLoad(source, p, 0).rgb);
    camera = max(value - sensor.black.rgb, vec3f(0.0))
      / (vec3f(sensor.white) - sensor.black.rgb) * calibration.gains;
  }
  let q = (vec2f(p) + 0.5) * vignette.step + vignette.origin;
  let r2 = dot(q, q);
  let k = vignette.coefficients;
  let gain = 1.0 + r2 * (k.x + r2 * (k.y + r2 * (k.z + r2 * (k.w + r2 * vignette.last))));
  return vec4f(calibration.matrix * camera * gain * calibration.exposure, 1.0);
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(points[index], 0, 1);
}
