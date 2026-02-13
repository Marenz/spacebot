import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChannelInfo } from "./api/client";
import { useEventSource, type ConnectionState } from "./hooks/useEventSource";
import { useChannelLiveState, type ActiveBranch, type ActiveWorker, type ChannelLiveState } from "./hooks/useChannelLiveState";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: 1,
			refetchOnWindowFocus: true,
		},
	},
});

const VISIBLE_MESSAGES = 6;

// -- Formatting utilities --

function formatUptime(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function formatTimeAgo(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function platformIcon(platform: string): string {
	switch (platform) {
		case "discord": return "Discord";
		case "slack": return "Slack";
		case "telegram": return "Telegram";
		case "webhook": return "Webhook";
		case "cron": return "Cron";
		default: return platform;
	}
}

function platformColor(platform: string): string {
	switch (platform) {
		case "discord": return "bg-indigo-500/20 text-indigo-400";
		case "slack": return "bg-green-500/20 text-green-400";
		case "telegram": return "bg-blue-500/20 text-blue-400";
		case "cron": return "bg-amber-500/20 text-amber-400";
		default: return "bg-gray-500/20 text-gray-400";
	}
}

// -- Components --

function ConnectionBanner({ state }: { state: ConnectionState }) {
	if (state === "connected") return null;

	const config: Record<Exclude<ConnectionState, "connected">, { label: string; color: string }> = {
		connecting: { label: "Connecting...", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
		reconnecting: { label: "Reconnecting... Dashboard may show stale data.", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
		disconnected: { label: "Disconnected from server.", color: "bg-red-500/10 text-red-400 border-red-500/20" },
	};

	const { label, color } = config[state];

	return (
		<div className={`border-b px-4 py-2 text-sm ${color}`}>
			<div className="mx-auto flex max-w-5xl items-center gap-2">
				<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
				{label}
			</div>
		</div>
	);
}

/** Ticking duration display that updates every second while the component is mounted. */
function LiveDuration({ startMs }: { startMs: number }) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, []);

	const seconds = Math.floor((now - startMs) / 1000);
	return <span>{formatDuration(seconds)}</span>;
}

function WorkerBadge({ worker }: { worker: ActiveWorker }) {
	return (
		<div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-tiny">
			<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-amber-300">Worker</span>
					<span className="truncate text-ink-dull">{worker.task}</span>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-ink-faint">
					<span>{worker.status}</span>
					{worker.currentTool && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span className="text-amber-400/70">{worker.currentTool}</span>
						</>
					)}
					{worker.toolCalls > 0 && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span>{worker.toolCalls} tools</span>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function BranchBadge({ branch }: { branch: ActiveBranch }) {
	const displayTool = branch.currentTool ?? branch.lastTool;
	return (
		<div className="flex items-center gap-2 rounded-md bg-violet-500/10 px-2.5 py-1.5 text-tiny">
			<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-violet-300">Branch</span>
					<span className="truncate text-ink-dull">{branch.description}</span>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-ink-faint">
					<LiveDuration startMs={branch.startedAt} />
					{displayTool && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span className={branch.currentTool ? "text-violet-400/70" : "text-violet-400/40"}>{displayTool}</span>
						</>
					)}
					{branch.toolCalls > 0 && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span>{branch.toolCalls} tools</span>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function ChannelCard({
	channel,
	liveState,
}: {
	channel: ChannelInfo;
	liveState: ChannelLiveState | undefined;
}) {
	const isTyping = liveState?.isTyping ?? false;
	const messages = liveState?.messages ?? [];
	const workers = Object.values(liveState?.workers ?? {});
	const branches = Object.values(liveState?.branches ?? {});
	const visible = messages.slice(-VISIBLE_MESSAGES);
	const hasActivity = workers.length > 0 || branches.length > 0;

	return (
		<div className="flex flex-col rounded-lg border border-app-line bg-app-darkBox transition-colors hover:border-app-line/80">
			{/* Header */}
			<div className="flex items-start justify-between p-4 pb-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="truncate font-medium text-ink">
							{channel.display_name ?? channel.id}
						</h3>
						{isTyping && (
							<div className="flex items-center gap-1">
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0.2s]" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0.4s]" />
							</div>
						)}
					</div>
					<div className="mt-1 flex items-center gap-2">
						<span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-tiny font-medium ${platformColor(channel.platform)}`}>
							{platformIcon(channel.platform)}
						</span>
						<span className="text-tiny text-ink-faint">
							{formatTimeAgo(channel.last_activity_at)}
						</span>
						{hasActivity && (
							<span className="text-tiny text-ink-faint">
								{workers.length > 0 && `${workers.length}w`}
								{workers.length > 0 && branches.length > 0 && " "}
								{branches.length > 0 && `${branches.length}b`}
							</span>
						)}
					</div>
				</div>
				<div className="ml-2 flex-shrink-0">
					<div className={`h-2 w-2 rounded-full ${
						hasActivity ? "bg-amber-400 animate-pulse" :
						isTyping ? "bg-accent animate-pulse" :
						"bg-green-500/60"
					}`} />
				</div>
			</div>

			{/* Active workers and branches */}
			{hasActivity && (
				<div className="flex flex-col gap-1.5 px-4 pb-2">
					{workers.map((worker) => (
						<WorkerBadge key={worker.id} worker={worker} />
					))}
					{branches.map((branch) => (
						<BranchBadge key={branch.id} branch={branch} />
					))}
				</div>
			)}

			{/* Message stream */}
			{visible.length > 0 && (
				<div className="flex flex-col gap-1 border-t border-app-line/50 p-3">
					{messages.length > VISIBLE_MESSAGES && (
						<span className="mb-1 text-tiny text-ink-faint">
							{messages.length - VISIBLE_MESSAGES} earlier messages
						</span>
					)}
					{visible.map((message) => (
						<div key={message.id} className="flex gap-2 text-sm">
							<span className="flex-shrink-0 text-tiny text-ink-faint">
								{formatTimestamp(message.timestamp)}
							</span>
							<span className={`flex-shrink-0 text-tiny font-medium ${
								message.sender === "user" ? "text-accent-faint" : "text-green-400"
							}`}>
								{message.sender === "user" ? (message.senderName ?? "user") : "bot"}
							</span>
							<p className="line-clamp-1 text-sm text-ink-dull">{message.text}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function Dashboard() {
	const { data: statusData, isError: statusError } = useQuery({
		queryKey: ["status"],
		queryFn: api.status,
		refetchInterval: 5000,
	});

	const { data: channelsData, isLoading: channelsLoading, isError: channelsError } = useQuery({
		queryKey: ["channels"],
		queryFn: api.channels,
		refetchInterval: 10000,
	});

	const channels = channelsData?.channels ?? [];
	const { liveStates, handlers, syncStatusSnapshot } = useChannelLiveState(channels);

	const onReconnect = useCallback(() => {
		syncStatusSnapshot();
		queryClient.invalidateQueries({ queryKey: ["channels"] });
		queryClient.invalidateQueries({ queryKey: ["status"] });
	}, [syncStatusSnapshot]);

	const { connectionState } = useEventSource(api.eventsUrl, {
		handlers,
		onReconnect,
	});

	// Invalidate channel list when we get new messages
	const prevChannelCount = useRef(channels.length);
	useEffect(() => {
		if (channels.length !== prevChannelCount.current) {
			prevChannelCount.current = channels.length;
		}
	}, [channels.length]);

	// Count totals for header
	const totalWorkers = useMemo(
		() => Object.values(liveStates).reduce((sum, s) => sum + Object.keys(s.workers).length, 0),
		[liveStates],
	);
	const totalBranches = useMemo(
		() => Object.values(liveStates).reduce((sum, s) => sum + Object.keys(s.branches).length, 0),
		[liveStates],
	);

	return (
		<div className="min-h-screen bg-app">
			<ConnectionBanner state={connectionState} />

			{/* Header */}
			<header className="border-b border-app-line bg-app-darkBox/50 px-6 py-4">
				<div className="mx-auto flex max-w-5xl items-center justify-between">
					<div>
						<h1 className="font-plex text-lg font-semibold text-ink">Spacebot</h1>
						<p className="text-tiny text-ink-faint">Control Interface</p>
					</div>
					<div className="flex items-center gap-4 text-sm">
						{statusError ? (
							<div className="flex items-center gap-1.5">
								<div className="h-2 w-2 rounded-full bg-red-500" />
								<span className="text-red-400">Unreachable</span>
							</div>
						) : statusData ? (
							<>
								<div className="flex items-center gap-1.5">
									<div className="h-2 w-2 rounded-full bg-green-500" />
									<span className="text-ink-dull">Running</span>
								</div>
								<span className="text-ink-faint">
									{formatUptime(statusData.uptime_seconds)}
								</span>
							</>
						) : null}
						{(totalWorkers > 0 || totalBranches > 0) && (
							<div className="flex items-center gap-2 text-tiny">
								{totalWorkers > 0 && (
									<span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-400">
										{totalWorkers} worker{totalWorkers !== 1 ? "s" : ""}
									</span>
								)}
								{totalBranches > 0 && (
									<span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-violet-400">
										{totalBranches} branch{totalBranches !== 1 ? "es" : ""}
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			</header>

			{/* Content */}
			<main className="mx-auto max-w-5xl p-6">
				<div className="mb-4 flex items-center justify-between">
					<h2 className="font-plex text-sm font-medium text-ink-dull">
						Active Channels
					</h2>
					<span className="text-tiny text-ink-faint">
						{channels.length} channel{channels.length !== 1 ? "s" : ""}
					</span>
				</div>

				{channelsLoading ? (
					<div className="flex items-center gap-2 text-ink-dull">
						<div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
						Loading channels...
					</div>
				) : channelsError ? (
					<div className="rounded-lg border border-dashed border-red-500/30 p-8 text-center">
						<p className="text-sm text-red-400">
							Failed to load channels. Is the daemon running?
						</p>
					</div>
				) : channels.length === 0 ? (
					<div className="rounded-lg border border-dashed border-app-line p-8 text-center">
						<p className="text-sm text-ink-faint">
							No active channels. Send a message via Discord, Telegram, or webhook to get started.
						</p>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						{channels.map((channel) => (
							<ChannelCard
								key={channel.id}
								channel={channel}
								liveState={liveStates[channel.id]}
							/>
						))}
					</div>
				)}
			</main>
		</div>
	);
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<Dashboard />
		</QueryClientProvider>
	);
}
