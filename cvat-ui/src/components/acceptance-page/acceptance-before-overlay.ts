/**
 * Draw ORIGINAL (pre-correction) shapes as a ghost SVG layer on the CVAT canvas.
 * Must sit above native shapes and stay visible when originals differ from current.
 */

export interface BeforeOverlayHandle {
    clear: () => void;
    setVisible: (visible: boolean) => void;
    shapeCount: number;
}

const LAYER_ID = 'cvat-acceptance-before-layer';
const COMPARING_CLASS = 'cvat-acceptance-comparing-original';

function ensureLayer(content: SVGSVGElement): SVGGElement {
    let layer = content.querySelector(`#${LAYER_ID}`) as SVGGElement | null;
    if (!layer) {
        layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        layer.setAttribute('id', LAYER_ID);
        layer.setAttribute('pointer-events', 'none');
    }
    // Always re-append so the layer stays on top of native shapes.
    content.appendChild(layer);
    return layer;
}

function readPoints(obj: any): number[] {
    if (Array.isArray(obj?.points) && obj.points.length >= 2) {
        return obj.points.map(Number);
    }
    // Some exports nest geometry under shapes[] / elements[]
    const nested = obj?.shapes?.[0] || obj?.elements?.[0];
    if (nested && nested !== obj) return readPoints(nested);
    return [];
}

function drawShape(layer: SVGGElement, obj: any, offset: number): void {
    const pts = readPoints(obj);
    const type = String(obj?.type || obj?.shapeType || obj?.shape || '').toLowerCase();
    const stroke = '#ea580c';
    const fill = 'rgba(234, 88, 12, 0.18)';

    if ((type === 'rectangle' || type === 'ellipse' || pts.length === 4) && pts.length >= 4) {
        const [xtl, ytl, xbr, ybr] = pts.length === 4 ? pts : pts.slice(0, 4);
        const el = document.createElementNS('http://www.w3.org/2000/svg', type === 'ellipse' ? 'ellipse' : 'rect');
        if (type === 'ellipse') {
            const cx = offset + (xtl + xbr) / 2;
            const cy = offset + (ytl + ybr) / 2;
            el.setAttribute('cx', String(cx));
            el.setAttribute('cy', String(cy));
            el.setAttribute('rx', String(Math.abs(xbr - xtl) / 2));
            el.setAttribute('ry', String(Math.abs(ybr - ytl) / 2));
        } else {
            el.setAttribute('x', String(offset + Math.min(xtl, xbr)));
            el.setAttribute('y', String(offset + Math.min(ytl, ybr)));
            el.setAttribute('width', String(Math.abs(xbr - xtl)));
            el.setAttribute('height', String(Math.abs(ybr - ytl)));
        }
        el.setAttribute('fill', fill);
        el.setAttribute('stroke', stroke);
        el.setAttribute('stroke-width', '3');
        el.setAttribute('stroke-dasharray', '8 5');
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(el);
        return;
    }

    if (pts.length >= 4) {
        const pairs: string[] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) {
            pairs.push(`${offset + pts[i]},${offset + pts[i + 1]}`);
        }
        const el = document.createElementNS(
            'http://www.w3.org/2000/svg',
            type === 'polyline' || type === 'points' ? 'polyline' : 'polygon',
        );
        el.setAttribute('points', pairs.join(' '));
        el.setAttribute('fill', type === 'polyline' || type === 'points' ? 'none' : fill);
        el.setAttribute('stroke', stroke);
        el.setAttribute('stroke-width', '3');
        el.setAttribute('stroke-dasharray', '8 5');
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(el);
    }
}

function collectDrawable(snapshot: any): any[] {
    const out: any[] = [];
    const shapes = Array.isArray(snapshot?.shapes) ? snapshot.shapes : [];
    out.push(...shapes);
    const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
    for (const track of tracks) {
        const shapesInTrack = track?.shapes || track?.elements;
        if (Array.isArray(shapesInTrack) && shapesInTrack.length) {
            // Prefer a shape on the snapshot frame when available.
            const frame = snapshot?.frame;
            const onFrame = typeof frame === 'number'
                ? shapesInTrack.filter((s: any) => s?.frame === frame && !s?.outside)
                : [];
            out.push(onFrame.length ? onFrame[onFrame.length - 1] : shapesInTrack[shapesInTrack.length - 1]);
        } else if (Array.isArray(track?.points)) {
            out.push(track);
        }
    }
    return out;
}

export function countOverlayDrawables(snapshot: any): number {
    return collectDrawable(snapshot).filter((o) => readPoints(o).length >= 4).length;
}

export function renderBeforeOverlay(snapshot: any, canvasInstance: any): BeforeOverlayHandle | null {
    try {
        const html: HTMLElement | undefined = canvasInstance?.html?.();
        if (!html) return null;
        const content = (html.querySelector('#cvat_canvas_content')
            || html.querySelector('svg')) as SVGSVGElement | null;
        if (!content) return null;

        const offset = Number(canvasInstance?.geometry?.offset ?? 0);
        const layer = ensureLayer(content);
        while (layer.firstChild) layer.removeChild(layer.firstChild);

        const drawables = collectDrawable(snapshot);
        let drawn = 0;
        for (const shape of drawables) {
            const before = layer.childNodes.length;
            drawShape(layer, shape, offset);
            if (layer.childNodes.length > before) drawn += 1;
        }

        layer.style.display = '';
        document.querySelector('.cvat-annotation-page')?.classList.add(COMPARING_CLASS);

        return {
            shapeCount: drawn,
            clear: () => {
                layer.remove();
                document.querySelector('.cvat-annotation-page')?.classList.remove(COMPARING_CLASS);
            },
            setVisible: (visible: boolean) => {
                layer.style.display = visible ? '' : 'none';
                document.querySelector('.cvat-annotation-page')?.classList.toggle(COMPARING_CLASS, visible);
            },
        };
    } catch (e) {
        console.warn('Failed to render ORIGINAL overlay', e);
        return null;
    }
}

export function clearBeforeOverlay(): void {
    document.querySelector(`#${LAYER_ID}`)?.remove();
    document.querySelector('.cvat-annotation-page')?.classList.remove(COMPARING_CLASS);
}
