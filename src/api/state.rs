//! Shared state for the HTTP API.

use crate::agent::status::StatusBlock;
use crate::{ProcessEvent, ProcessId};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, RwLock};

/// State shared across all API handlers.
pub struct ApiState {
    pub started_at: Instant,
    /// Aggregated event stream from all agents. SSE clients subscribe here.
    pub event_tx: broadcast::Sender<ApiEvent>,
    /// Per-agent SQLite pools for querying channel/conversation data.
    pub agent_pools: arc_swap::ArcSwap<HashMap<String, sqlx::SqlitePool>>,
    /// Live status blocks for active channels, keyed by channel_id.
    pub channel_status_blocks: RwLock<HashMap<String, Arc<tokio::sync::RwLock<StatusBlock>>>>,
}

/// Events sent to SSE clients. Wraps ProcessEvents with agent context.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApiEvent {
    /// An inbound message from a user.
    InboundMessage {
        agent_id: String,
        channel_id: String,
        sender_id: String,
        text: String,
    },
    /// An outbound message sent by the bot.
    OutboundMessage {
        agent_id: String,
        channel_id: String,
        text: String,
    },
    /// Typing indicator state change.
    TypingState {
        agent_id: String,
        channel_id: String,
        is_typing: bool,
    },
    /// A worker was started.
    WorkerStarted {
        agent_id: String,
        channel_id: Option<String>,
        worker_id: String,
        task: String,
    },
    /// A worker's status changed.
    WorkerStatusUpdate {
        agent_id: String,
        channel_id: Option<String>,
        worker_id: String,
        status: String,
    },
    /// A worker completed.
    WorkerCompleted {
        agent_id: String,
        channel_id: Option<String>,
        worker_id: String,
        result: String,
    },
    /// A branch was started.
    BranchStarted {
        agent_id: String,
        channel_id: String,
        branch_id: String,
        description: String,
    },
    /// A branch completed with a conclusion.
    BranchCompleted {
        agent_id: String,
        channel_id: String,
        branch_id: String,
        conclusion: String,
    },
    /// A tool call started on a process.
    ToolStarted {
        agent_id: String,
        channel_id: Option<String>,
        process_type: String,
        process_id: String,
        tool_name: String,
    },
    /// A tool call completed on a process.
    ToolCompleted {
        agent_id: String,
        channel_id: Option<String>,
        process_type: String,
        process_id: String,
        tool_name: String,
    },
}

impl ApiState {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        Self {
            started_at: Instant::now(),
            event_tx,
            agent_pools: arc_swap::ArcSwap::from_pointee(HashMap::new()),
            channel_status_blocks: RwLock::new(HashMap::new()),
        }
    }

    /// Register a channel's status block so the API can read snapshots.
    pub async fn register_channel_status(
        &self,
        channel_id: String,
        status_block: Arc<tokio::sync::RwLock<StatusBlock>>,
    ) {
        self.channel_status_blocks
            .write()
            .await
            .insert(channel_id, status_block);
    }

    /// Remove a channel's status block when it's dropped.
    pub async fn unregister_channel_status(&self, channel_id: &str) {
        self.channel_status_blocks
            .write()
            .await
            .remove(channel_id);
    }

    /// Register an agent's event stream. Spawns a task that forwards
    /// ProcessEvents into the aggregated API event stream.
    pub fn register_agent_events(
        &self,
        agent_id: String,
        mut agent_event_rx: broadcast::Receiver<ProcessEvent>,
    ) {
        let api_tx = self.event_tx.clone();
        tokio::spawn(async move {
            loop {
                match agent_event_rx.recv().await {
                    Ok(event) => {
                        // Translate ProcessEvents into typed ApiEvents
                        match &event {
                            ProcessEvent::WorkerStarted { worker_id, channel_id, task, .. } => {
                                api_tx.send(ApiEvent::WorkerStarted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.as_deref().map(|s| s.to_string()),
                                    worker_id: worker_id.to_string(),
                                    task: task.clone(),
                                }).ok();
                            }
                            ProcessEvent::BranchStarted { branch_id, channel_id, description, .. } => {
                                api_tx.send(ApiEvent::BranchStarted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.to_string(),
                                    branch_id: branch_id.to_string(),
                                    description: description.clone(),
                                }).ok();
                            }
                            ProcessEvent::WorkerStatus { worker_id, channel_id, status, .. } => {
                                api_tx.send(ApiEvent::WorkerStatusUpdate {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.as_deref().map(|s| s.to_string()),
                                    worker_id: worker_id.to_string(),
                                    status: status.clone(),
                                }).ok();
                            }
                            ProcessEvent::WorkerComplete { worker_id, channel_id, result, .. } => {
                                api_tx.send(ApiEvent::WorkerCompleted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.as_deref().map(|s| s.to_string()),
                                    worker_id: worker_id.to_string(),
                                    result: result.clone(),
                                }).ok();
                            }
                            ProcessEvent::BranchResult { branch_id, channel_id, conclusion, .. } => {
                                api_tx.send(ApiEvent::BranchCompleted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.to_string(),
                                    branch_id: branch_id.to_string(),
                                    conclusion: conclusion.clone(),
                                }).ok();
                            }
                            ProcessEvent::ToolStarted { process_id, channel_id, tool_name, .. } => {
                                let (process_type, id_str) = process_id_info(process_id);
                                api_tx.send(ApiEvent::ToolStarted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.as_deref().map(|s| s.to_string()),
                                    process_type,
                                    process_id: id_str,
                                    tool_name: tool_name.clone(),
                                }).ok();
                            }
                            ProcessEvent::ToolCompleted { process_id, channel_id, tool_name, .. } => {
                                let (process_type, id_str) = process_id_info(process_id);
                                api_tx.send(ApiEvent::ToolCompleted {
                                    agent_id: agent_id.clone(),
                                    channel_id: channel_id.as_deref().map(|s| s.to_string()),
                                    process_type,
                                    process_id: id_str,
                                    tool_name: tool_name.clone(),
                                }).ok();
                            }
                            _ => {}
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(count)) => {
                        tracing::debug!(agent_id = %agent_id, count, "API event forwarder lagged, skipped events");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Set the SQLite pools for all agents.
    pub fn set_agent_pools(&self, pools: HashMap<String, sqlx::SqlitePool>) {
        self.agent_pools.store(Arc::new(pools));
    }
}

/// Extract (process_type, id_string) from a ProcessId.
fn process_id_info(id: &ProcessId) -> (String, String) {
    match id {
        ProcessId::Channel(channel_id) => ("channel".into(), channel_id.to_string()),
        ProcessId::Branch(branch_id) => ("branch".into(), branch_id.to_string()),
        ProcessId::Worker(worker_id) => ("worker".into(), worker_id.to_string()),
    }
}
