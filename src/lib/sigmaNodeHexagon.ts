/**
 * Sigma 3 node program: firm hexagon matching /graph Morgan Stanley style.
 * Pointy-top dark fill (#0f172a) + bright cyan stroke (#22d3ee) + soft glow.
 *
 * Geometry matches SVG:
 *   (0,-r), (±r*√3/2, ±r/2), (0,r)
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
// Cover pointy-top hexagon (vertex radius = size) plus stroke/glow margin.
const float marginRatio = 1.18;

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
// /graph .graph-node.firm stroke #22d3ee
const vec3 CYAN = vec3(0.13333334, 0.82745098, 0.93333334);
const vec3 CYAN_GLOW = vec3(0.25, 0.92, 1.0);

void main(void) {
  // Unit space where hexagon vertices sit at distance 1 (pointy-top).
  vec2 p = v_diffVector / max(v_radius, 1e-5);
  float ax = abs(p.x);
  float ay = abs(p.y);

  // Pointy-top regular hexagon, circumradius 1:
  // vertices (0,±1), (±√3/2, ±1/2); vertical flats at |x|=√3/2.
  // inside <= 1 is interior.
  float inside = max(ax * 1.15470053838, ax * 0.57735026919 + ay);

  // Crisp outer AA
  float edge = 1.0 - smoothstep(0.96, 1.0, inside);

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
    // Flat dark body (node color = #0f172a) like /graph fill.
    vec3 fill = v_color.rgb;

    // Cyan stroke band (≈ stroke-width 2.5 relative to node) + outer glow.
    float rim = smoothstep(0.78, 0.90, inside) * (1.0 - smoothstep(0.985, 1.0, inside));
    float glow = smoothstep(0.90, 1.05, inside) * edge;

    vec3 rgb = mix(fill, CYAN, clamp(rim * 1.1, 0.0, 1.0));
    rgb = mix(rgb, CYAN_GLOW, glow * 0.45);

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
