// rulers.js — the measuring tool shared by the GM and player screens: snapping,
// straight/curved preview lines, the distance tooltip, and synced final segments.
// Rulers are persisted per map on the server; pages pass an `emit` callback so
// finalized lines round-trip through Socket.IO ('add-ruler' / 'ruler-added').

import * as THREE from 'three';
import { GRID_CELL_SIZE, FEET_PER_GRID_CELL, rulerSnap } from './scene.js';

export class RulerTool {
    // measure (optional): (points) => ({ value, unit }) | null. The GM uses it for
    // km-per-hex distances on world/region layers; null falls back to feet.
    constructor({ scene, tooltip, measure = null }) {
        this.scene = scene;
        this.tooltip = tooltip;
        this.measure = measure;

        this.mode = 'straight';
        this.color = 0x00ffff;
        this.snapMode = 'center';
        this.points = [];
        this.currentLine = null;   // in-progress preview line
        this.segments = [];        // finalized, synced lines
        this.lastClickTime = 0;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2, transparent: true, opacity: 0.8 });
        this.previewMaterial = new THREE.LineDashedMaterial({
            color: 0x00ffff, linewidth: 1, transparent: true, opacity: 0.7, dashSize: 0.2, gapSize: 0.1
        });
    }

    setMode(mode) { this.mode = mode; }
    setSnapMode(mode) { this.snapMode = mode; }
    setColor(colorValue) {
        this.color = parseInt(colorValue);
        this.lineMaterial.color.setHex(this.color);
        this.previewMaterial.color.setHex(this.color);
    }

    snap(rawPosition) { return rulerSnap(rawPosition, this.snapMode); }
    trackMouse(event) { this.lastMouseX = event.clientX; this.lastMouseY = event.clientY; }
    hideTooltip() { this.tooltip.style.display = 'none'; }

    // Left-click on the ground: double-click finalizes, otherwise add a point.
    click(snappedPosition, emit) {
        if (this.points.length === 0) this.hideTooltip();
        const now = Date.now();
        if (now - this.lastClickTime < 300) {
            this.finalize(emit);
        } else {
            this.points.push(snappedPosition);
        }
        this.lastClickTime = now;
    }

    // Right-click: finalize the current line (kept on the map) and start a new one.
    restartAt(snappedPosition, emit) {
        if (this.points.length > 0) this.finalize(emit, false);
        this.points = [snappedPosition];
        this.lastClickTime = Date.now();
    }

    _geometryPoints(points) {
        if (this.mode === 'curved') {
            const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
            return curve.getPoints(points.length * 10);
        }
        return points;
    }

    lineLength(points) {
        let totalLength = 0;
        if (!points || points.length < 2) return 0;
        for (let i = 0; i < points.length - 1; i++) {
            totalLength += points[i].distanceTo(points[i + 1]);
        }
        return totalLength;
    }

    updateTooltip(points, isFinal = false, showAtZero = false) {
        if (!this.tooltip) return;
        const measured = this.measure ? this.measure(points) : null;
        const unit = measured ? measured.unit : 'ft';

        if (showAtZero && points.length === 0) {
            this.tooltip.style.display = 'block';
            this.tooltip.textContent = '0 ' + unit;
            this.tooltip.style.left = `${this.lastMouseX}px`;
            this.tooltip.style.top = `${this.lastMouseY}px`;
            return;
        }
        if (points.length < 2) {
            this.hideTooltip();
            return;
        }

        let value;
        if (measured) {
            value = measured.value;
        } else {
            let totalLength;
            if (this.mode === 'curved' && points.length > 1) {
                const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
                totalLength = curve.getLength();
            } else {
                totalLength = this.lineLength(points);
            }
            value = (totalLength / GRID_CELL_SIZE) * FEET_PER_GRID_CELL;
        }

        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${this.lastMouseX}px`;
        this.tooltip.style.top = `${this.lastMouseY}px`;
        this.tooltip.textContent = (isFinal ? 'Total: ' : '') + value.toFixed(1) + ' ' + unit;
    }

    updatePreview(previewPoints) {
        if (this.currentLine) {
            this.scene.remove(this.currentLine);
            this.currentLine.geometry.dispose();
        }
        if (previewPoints.length < 2) return;
        const geometryPoints = this._geometryPoints(previewPoints);
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(geometryPoints);
        this.currentLine = new THREE.Line(lineGeometry, this.previewMaterial);
        this.currentLine.material.color.setHex(this.color);
        this.currentLine.computeLineDistances();
        this.scene.add(this.currentLine);
    }

    // Build a synced segment from server data ('ruler-added' / 'map-state').
    addFromData(id, data) {
        const points = data.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
        const finalGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const finalLine = new THREE.Line(finalGeometry, this.lineMaterial.clone());
        finalLine.material.color.setHex(data.color);
        finalLine.userData.syncId = id;
        finalLine.userData.rulerData = data;
        this.segments.push(finalLine);
        this.scene.add(finalLine);
    }

    hasSegment(id) { return this.segments.some(s => s.userData.syncId === id); }

    // Finalize the in-progress line and emit it to the server; the 'ruler-added'
    // echo (via addFromData) is what actually draws the shared segment.
    finalize(emit, shouldClearPoints = true) {
        if (this.currentLine) {
            this.scene.remove(this.currentLine);
            this.currentLine.geometry.dispose();
        }
        if (this.points.length < 2) {
            this.clearInProgress();
            return;
        }
        const finalGeometryPoints = this._geometryPoints(this.points);
        this.updateTooltip(finalGeometryPoints, true);
        emit({
            points: finalGeometryPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
            mode: this.mode,
            color: this.color
        });
        if (shouldClearPoints) this.clearInProgress();
    }

    clearInProgress() {
        if (this.currentLine) {
            this.scene.remove(this.currentLine);
            this.currentLine.geometry.dispose();
            this.currentLine = null;
        }
        this.points = [];
        this.lastClickTime = 0;
        this.hideTooltip();
    }

    // Clear everything: local preview plus a server round-trip ('clear-rulers' →
    // 'rulers-cleared' → removeSegments) so all clients stay in sync.
    clearAll(emit) {
        this.clearInProgress();
        emit();
    }

    // Drop all finalized segments (map switch or 'rulers-cleared').
    removeSegments() {
        this.segments.forEach(segment => {
            this.scene.remove(segment);
            segment.geometry.dispose();
        });
        this.segments = [];
    }
}
