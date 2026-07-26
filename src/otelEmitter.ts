import * as vscode from 'vscode';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, Tracer, Span } from '@opentelemetry/api';

let sdk: NodeSDK | undefined;
let tracer: Tracer | undefined;

export function initOtel(context: vscode.ExtensionContext) {
    if (sdk) {
        return;
    }

    const config = vscode.workspace.getConfiguration('stuck');
    const endpoint = config.get<string>('otlpEndpoint', 'http://localhost:4318');
    
    // Ensure the endpoint has /v1/traces if it's just the base URL
    const traceUrl = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;

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

export function startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span | undefined {
    if (!tracer) {
        return undefined;
    }
    
    const span = tracer.startSpan(name);
    if (attributes) {
        span.setAttributes(attributes);
    }
    return span;
}
