use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait SidecarTransport: Send + Sync {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}
