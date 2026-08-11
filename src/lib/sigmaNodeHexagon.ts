/**
 * Sigma 3 node program: bright vector hexagon for firm nodes.
 * Pointy-top filled hex with crisp AA edges + luminous cyan stroke.
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

uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform mat3 u_matrix;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

const float bias = 255.0 / 254.0;
// Cover pointy-top hexagon (vertices at r) with a slightly larger disc.
const float marginRatio = 1.08;

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * marginRatio;
  vec2 diffVector = vec2(cos(a_angle), sin(a_angle)) * size;
  vec2 position = (u_matrix * vec3(a_position + diffVector, 1.0)).xy;
  gl_Position = vec4(position, 0.0, 1.0);

  v_diffVector = diffVector;
  v_radius = size / marginRatio;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
  v_color.a *= bias;
}
`;

const FRAGMENT_SHADER_SOURCE = /* glsl */ `
precision mediump float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  // Normalize into unit space where hexagon vertices sit at distance 1.
  vec2 p = v_diffVector / max(v_radius, 1e-5);
  float ax = abs(p.x);
  float ay = abs(p.y);
  // Pointy-top regular hexagon signed distance proxy (max of half-planes).
  // Vertices at r=1 ⇒ flat edges at cos(30°)=√3/2 along axes.
  float inside = max(ay * 0.57735026919 + ax, ay);
  // Crisp vector AA — thin edge band for a sharp polygon silhouette.
  float edge = 1.0 - smoothstep(0.965, 1.0, inside);

  #ifdef PICKING_MODE
  if (edge < 0.5) {
    gl_FragColor = transparent;
  } else {
    gl_FragColor = v_color;
  }
  #else
  if (edge <= 0.001) {
    gl_FragColor = transparent;
  } else {
    // Bright fill (node color) + luminous cyan rim for a vector-icon look.
    float rim = smoothstep(0.82, 0.92, inside) * (1.0 - smoothstep(0.985, 1.0, inside));
    // Soft center glow so the hex reads as a lit glyph, not a flat disc.
    float glow = 1.0 - smoothstep(0.0, 0.85, inside);
    vec3 fill = v_color.rgb;
    vec3 hi = min(vec3(1.0), fill * 1.35 + vec3(0.12, 0.22, 0.28) * glow);
    vec3 stroke = vec3(0.45, 0.96, 1.0); // #73f5ff bright cyan
    vec3 rgb = mix(hi, stroke, rim * 0.98);
    gl_FragColor = vec4(rgb, min(1.0, v_color.a) * edge);
  }
  #endif
}
`;

const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const;

type ProgramInfoLike = {
	gl: WebGLRenderingContext | WebGL2RenderingContext;
	uniformLocations: Record<(typeof UNIFORMS)[number], WebGLUniformLocation>;
};

export default class NodeHexagonProgram<N extends Attributes = Attributes, E extends Attributes = Attributes, G extends Attributes = Attributes> extends NodeProgram<
	(typeof UNIFORMS)[number],
	N,
	E,
	G
> {
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
			CONSTANT_DATA: [[NodeHexagonProgram.ANGLE_1], [NodeHexagonProgram.ANGLE_2], [NodeHexagonProgram.ANGLE_3]],
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
