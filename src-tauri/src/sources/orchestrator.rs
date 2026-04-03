use super::provider::{SearchResultItem, SourceProvider};
use std::sync::Arc;

pub struct SourceOrchestrator {
    providers: Vec<Arc<dyn SourceProvider>>,
}

impl SourceOrchestrator {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
        }
    }

    pub fn register(&mut self, provider: Arc<dyn SourceProvider>) {
        self.providers.push(provider);
    }

    pub async fn search_all(&self, query: &str) -> Vec<SearchResultItem> {
        let mut all_results = Vec::new();

        for provider in &self.providers {
            if !provider.is_healthy() {
                continue;
            }
            match provider.search(query, 0).await {
                Ok(results) => {
                    all_results.extend(results.items);
                }
                Err(e) => {
                    log::warn!("Provider {} search failed: {}", provider.name(), e);
                }
            }
        }

        all_results
    }

    pub fn healthy_providers(&self) -> Vec<String> {
        self.providers
            .iter()
            .filter(|p| p.is_healthy())
            .map(|p| p.name().to_string())
            .collect()
    }
}
