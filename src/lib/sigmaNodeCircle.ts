/**
 * Sigma 3 node program: solid circle with a soft outer glow matching /graph people nodes.
 *
 * Sizing follows Sigma's NodeCircleProgram:
 *   size = a_size * u_correctionRatio / u_sizeRatio * 4.0
 *   v_radius = size / 2.0
 */
import type { Attributes } from 'graphology-types';
import { NodeProgram } from 'sigma/rendering';
import { floatColor } from 'sigma/utils';
import type { NodeDisplayData, RenderParams } from 'sigma/types';

const VERTEX_SHADER_SOURCE = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

const float bias = 255.0 / 254.0;

void main() {
  // Same scale factor as Sigma NodeCircleProgram so hex size matches circle size.
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4(
    (u_matrix * vec3(position, 1.0)).xy,
    0.0,
    1.0
  );

  v_diffVector = diffVector;
  // Circle program: radius = size/2. Hexagon circumradius uses the same value.
  v_radius = size / 2.0;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
  v_color.a *= bias;
}
`;

const FRAGMENT_SHADER_SOURCE = /* glsl */ `
precision highp float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);
// /graph .graph-node.individual fill/stroke #0ea5e9
const vec3 BLUE_GLOW = vec3(0.05, 0.65, 0.91);

void main(void) {
  vec2 p = v_diffVector / max(v_radius, 1e-5);
  float inside = length(p);

  float border = (u_correctionRatio * 2.0) / max(v_radius, 1e-5);
  float dist = inside - 1.0 + border;

  #ifdef PICKING_MODE
  if (dist > border) {
    gl_FragColor = transparent;
  } else {
    gl_FragColor = v_color;
  }
  #else
  if (dist > border) {
    gl_FragColor = transparent;
  } else {
    float t = 0.0;
    if (dist > 0.0) t = dist / border;

    // Solid body + soft outer glow
    vec3 fill = v_color.rgb;
    float glow = smoothstep(0.70, 1.08, inside) * (1.0 - t);
    
    vec3 rgb = fill;
    rgb = mix(rgb, BLUE_GLOW, glow * 0.4);

    gl_FragColor = mix(vec4(rgb, min(1.0, v_color.a)), transparent, t);
  }
  #endif
}
`;

const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const;

type ProgramInfoLike = {
	gl: WebGLRenderingContext | WebGL2RenderingContext;
	uniformLocations: Record<(typeof UNIFORMS)[number], WebGLUniformLocation>;
};

export default class NodeCircleGlowProgram<
	N extends Attributes = Attributes,
	E extends Attributes = Attributes,
	G extends Attributes = Attributes,
> extends NodeProgram<(typeof UNIFORMS)[number], N, E, G> {
	static ANGLE_1 = 0;
	static ANGLE_2 = (2 * Math.PI) / 3;
	static ANGLE_3 = (4 * Math.PI) / 3;

	getDefinition() {
		return {
			VERTICES: 3,
			VERTEX_SHADER_SOURCE,
			FRAGMENT_SHADER_SOURCE,
			METHOD: WebGLRenderingContext.TRIANGLES,
			UNIFORMS,
			ATTRIBUTES: [
				{ name: 'a_position', size: 2, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_size', size: 1, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_color', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
				{ name: 'a_id', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
			],
			CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: WebGLRenderingContext.FLOAT }],
			CONSTANT_DATA: [[NodeCircleGlowProgram.ANGLE_1], [NodeCircleGlowProgram.ANGLE_2], [NodeCircleGlowProgram.ANGLE_3]],
		};
	}

	processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData) {
		const array = this.array;
		const color = floatColor(data.color);
		array[startIndex++] = data.x;
		array[startIndex++] = data.y;
		array[startIndex++] = data.size;
		array[startIndex++] = color;
		array[startIndex++] = nodeIndex;
	}

	setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfoLike) {
		const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations;
		gl.uniform1f(u_correctionRatio, params.correctionRatio);
		gl.uniform1f(u_sizeRatio, params.sizeRatio);
		gl.uniformMatrix3fv(u_matrix, false, params.matrix);
	}
}
