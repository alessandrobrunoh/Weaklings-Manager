//! OpenTelemetry setup for exporting backend request traces.

use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::{Layer, filter::filter_fn};

/// Builds an OTLP tracer provider when an endpoint is configured.
///
/// OTLP export is opt-in: the backend keeps its normal console logger when no
/// OTLP endpoint is configured or when exporter configuration is invalid.
pub fn init_tracer_provider() -> Option<SdkTracerProvider> {
    let endpoint_configured = has_endpoint(std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok())
        || has_endpoint(std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").ok());

    let provider = if endpoint_configured {
        match SpanExporter::builder().build() {
            Ok(exporter) => Some(
                SdkTracerProvider::builder()
                    .with_batch_exporter(exporter)
                    .build(),
            ),
            Err(_) => {
                eprintln!(
                    "WARNING: OpenTelemetry exporter configuration failed; continuing with console tracing"
                );
                None
            }
        }
    } else {
        None
    };

    if let Some(provider) = &provider {
        opentelemetry::global::set_tracer_provider(provider.clone());
    }

    provider
}

/// Creates the tracing layer backed by the configured global OpenTelemetry provider.
pub fn tracing_layer<S>() -> impl Layer<S> + Send + Sync + 'static
where
    S: tracing::Subscriber
        + Send
        + Sync
        + 'static
        + for<'span> tracing_subscriber::registry::LookupSpan<'span>,
{
    tracing_opentelemetry::layer()
        .with_tracer(opentelemetry::global::tracer("backend"))
        .with_filter(filter_fn(|metadata| {
            metadata.is_span() && metadata.name() == "http.server.request"
        }))
}

fn has_endpoint(endpoint: Option<String>) -> bool {
    endpoint.is_some_and(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::has_endpoint;

    #[test]
    fn endpoint_is_enabled_only_when_non_empty() {
        assert!(has_endpoint(Some("http://collector:4317".to_owned())));
        assert!(!has_endpoint(Some("  ".to_owned())));
        assert!(!has_endpoint(None));
    }
}
