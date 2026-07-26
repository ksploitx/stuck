import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, Tracer, Span } from '@opentelemetry/api';

let sdk: NodeSDK | undefined;
let tracer: Tracer | undefined;

/** Session trace ID — generated once per activation, used to correlate all spans in a session */
let sessionTraceId: string = generateTraceId();

/** Cached OTLP endpoint base URL */
let otlpBaseEndpoint: string = 'http://localhost:4318';

/** Callback fired whenever a span is emitted — used by postmortem idle-timeout detection */
let spanEmittedCallback: (() => void) | undefined;

function generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function initOtel(context: vscode.ExtensionContext) {
    if (sdk) {
        return;
    }

    const config = vscode.workspace.getConfiguration('stuck');
    const endpoint = config.get<string>('otlpEndpoint', 'http://localhost:4318');
    otlpBaseEndpoint = endpoint.replace(/\/$/, '');
    
    // Ensure the endpoint has /v1/traces if it's just the base URL
    const traceUrl = endpoint.endsWith('/v1/traces') ? endpoint : `${otlpBaseEndpoint}/v1/traces`;

    const traceExporter = new OTLPTraceExporter({
        url: traceUrl,
    });

    sdk = new NodeSDK({
        serviceName: 'stuck-extension',
        traceExporter,
    });

    try {
        sdk.start();
        tracer = trace.getTracer('stuck-tracer');
        context.subscriptions.push({
            dispose: () => {
                if (sdk) {
                    sdk.shutdown();
                    sdk = undefined;
                }
            }
        });
    } catch (error) {
        console.error('Error initializing OpenTelemetry SDK', error);
    }
}

/**
 * Returns the shared tracer instance, or undefined if OTel hasn't been initialized.
 * Used by cdpBridge to create spans without duplicating the SDK.
 */
export function getTracer(): Tracer | undefined {
    return tracer;
}

/**
 * Returns the session-level trace ID. All spans in a single extension
 * activation share this ID so the postmortem engine can query the full
 * trace tree from SigNoz.
 */
export function getSessionTraceId(): string {
    return sessionTraceId;
}

/**
 * Reset the session trace ID (e.g. on task-end to start a new session).
 */
export function resetSessionTraceId(): string {
    sessionTraceId = generateTraceId();
    return sessionTraceId;
}

/**
 * Returns the configured OTLP base endpoint (without path suffix).
 * Used by postmortem.ts to derive the SigNoz query API URL.
 */
export function getOtlpEndpoint(): string {
    return otlpBaseEndpoint;
}

/**
 * Register a callback that fires whenever a span is emitted.
 * Used by the postmortem engine to reset the idle-timeout timer.
 */
export function onSpanEmitted(callback: () => void): void {
    spanEmittedCallback = callback;
}

export function startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span | undefined {
    if (!tracer) {
        return undefined;
    }
    
    const span = tracer.startSpan(name);
    if (attributes) {
        span.setAttributes(attributes);
    }

    // Notify listener that a span was emitted
    if (spanEmittedCallback) {
        spanEmittedCallback();
    }

    return span;
}
