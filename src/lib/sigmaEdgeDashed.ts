/**
 * Sigma 3 edge program: thick rectangle edges with a dashed pattern along the span.
 * Based on EdgeRectangleProgram; fragments are discarded in dash gaps.
 */
import type { Attributes } from 'graphology-types';
import { EdgeProgram } from 'sigma/rendering';
import { floatColor } from 'sigma/utils';
import type { EdgeDisplayData, NodeDisplayData, RenderParams } from 'sigma/types';

const VERTEX_SHADER_SOURCE = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_normal;
attribute float a_normalCoef;
attribute vec2 a_positionStart;
attribute vec2 a_positionEnd;
attribute float a_positionCoef;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_zoomRatio;
uniform float u_pixelRatio;
uniform float u_correctionRatio;
uniform float u_minEdgeThickness;
uniform float u_feather;

varying vec4 v_color;
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;
varying float v_progress;

const float bias = 255.0 / 254.0;

void main() {
  float minThickness = u_minEdgeThickness;

  vec2 normal = a_normal * a_normalCoef;
  vec2 position = a_positionStart * (1.0 - a_positionCoef) + a_positionEnd * a_positionCoef;

  float normalLength = length(normal);
  vec2 unitNormal = normal / normalLength;

  float pixelsThickness = max(normalLength, minThickness * u_sizeRatio);
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;

  gl_Position = vec4((u_matrix * vec3(position + unitNormal * webGLThickness, 1)).xy, 0, 1);

  v_thickness = webGLThickness / u_zoomRatio;
  v_normal = unitNormal;
  v_feather = u_feather * u_correctionRatio / u_zoomRatio / u_pixelRatio * 2.0;
  v_progress = a_positionCoef;

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
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;
varying float v_progress;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);
// Dash length in progress units (0–1 along edge). Longer ON segment so previous
// employment spokes stay easy to see on dark backgrounds.
const float DASH_PERIOD = 0.10;
const float DASH_ON = 0.72;

void main(void) {
  #ifdef PICKING_MODE
  // Keep full stroke pickable so dashed gaps still receive clicks.
  gl_FragColor = v_color;
  #else
  float phase = mod(v_progress, DASH_PERIOD) / DASH_PERIOD;
  if (phase > DASH_ON) {
    gl_FragColor = transparent;
    return;
  }

  float dist = length(v_normal) * v_thickness;
  float t = smoothstep(
    v_thickness - v_feather,
    v_thickness,
    dist
  );
  gl_FragColor = mix(v_color, transparent, t);
  #endif
}
`;

const UNIFORMS = ['u_matrix', 'u_zoomRatio', 'u_sizeRatio', 'u_correctionRatio', 'u_pixelRatio', 'u_feather', 'u_minEdgeThickness'] as const;

type ProgramInfoLike = {
	gl: WebGLRenderingContext | WebGL2RenderingContext;
	uniformLocations: Record<(typeof UNIFORMS)[number], WebGLUniformLocation>;
};

export default class EdgeDashedProgram<N extends Attributes = Attributes, E extends Attributes = Attributes, G extends Attributes = Attributes> extends EdgeProgram<
	(typeof UNIFORMS)[number],
	N,
	E,
	G
> {
	getDefinition() {
		return {
			VERTICES: 6,
			VERTEX_SHADER_SOURCE,
			FRAGMENT_SHADER_SOURCE,
			METHOD: WebGLRenderingContext.TRIANGLES,
			UNIFORMS,
			ATTRIBUTES: [
				{ name: 'a_positionStart', size: 2, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_positionEnd', size: 2, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_normal', size: 2, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_color', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
				{ name: 'a_id', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
			],
			CONSTANT_ATTRIBUTES: [
				{ name: 'a_positionCoef', size: 1, type: WebGLRenderingContext.FLOAT },
				{ name: 'a_normalCoef', size: 1, type: WebGLRenderingContext.FLOAT },
			],
			CONSTANT_DATA: [
				[0, 1],
				[0, -1],
				[1, 1],
				[1, 1],
				[0, -1],
				[1, -1],
			],
		};
	}

	processVisibleItem(edgeIndex: number, startIndex: number, sourceData: NodeDisplayData, targetData: NodeDisplayData, data: EdgeDisplayData) {
		const thickness = data.size || 1;
		const x1 = sourceData.x;
		const y1 = sourceData.y;
		const x2 = targetData.x;
		const y2 = targetData.y;
		const color = floatColor(data.color);

		let dx = x2 - x1;
		let dy = y2 - y1;
		let len = dx * dx + dy * dy;
		let n1 = 0;
		let n2 = 0;
		if (len) {
			len = 1 / Math.sqrt(len);
			n1 = -dy * len * thickness;
			n2 = dx * len * thickness;
		}

		const array = this.array;
		array[startIndex++] = x1;
		array[startIndex++] = y1;
		array[startIndex++] = x2;
		array[startIndex++] = y2;
		array[startIndex++] = n1;
		array[startIndex++] = n2;
		array[startIndex++] = color;
		array[startIndex++] = edgeIndex;
	}

	setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfoLike) {
		const { u_matrix, u_zoomRatio, u_sizeRatio, u_correctionRatio, u_pixelRatio, u_feather, u_minEdgeThickness } = uniformLocations;
		gl.uniformMatrix3fv(u_matrix, false, params.matrix);
		gl.uniform1f(u_zoomRatio, params.zoomRatio);
		gl.uniform1f(u_sizeRatio, params.sizeRatio);
		gl.uniform1f(u_correctionRatio, params.correctionRatio);
		gl.uniform1f(u_pixelRatio, params.pixelRatio);
		gl.uniform1f(u_feather, params.antiAliasingFeather);
		gl.uniform1f(u_minEdgeThickness, params.minEdgeThickness);
	}
}
