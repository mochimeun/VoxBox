import { apiFetch } from "./api";

function toLegacyVideo(video) {
  return {
    id: { videoId: video.id, channelId: video.channelId },
    snippet: {
      title: video.title,
      description: video.description,
      channelId: video.channelId,
      channelTitle: video.channelName,
      thumbnails: { high: { url: video.thumbnailUrl || "/video-placeholder.svg" } },
    },
    statistics: {
      viewCount: String(video.views),
      likeCount: String(video.likes),
    },
  };
}

function toLegacyChannel(channel) {
  return {
    id: { channelId: channel.id },
    snippet: {
      title: channel.name,
      channelId: channel.id,
      thumbnails: { high: { url: "/video-placeholder.svg" } },
    },
    statistics: { subscriberCount: String(channel.subscriberCount) },
  };
}

export async function fetchFromAPI(url) {
  const [resource, queryString = ""] = url.split("?");
  const params = new URLSearchParams(queryString);

  if (resource === "videos") {
    const result = await apiFetch(`/api/videos/${encodeURIComponent(params.get("id") || "")}`);
    return { items: [toLegacyVideo(result.video)] };
  }

  if (resource === "channels") {
    const result = await apiFetch(`/api/channels/${encodeURIComponent(params.get("id") || "")}`);
    return { items: [toLegacyChannel(result.channel)] };
  }

  if (resource === "search") {
    const channelId = params.get("channelId");
    const result = channelId
      ? await apiFetch(`/api/channels/${encodeURIComponent(channelId)}/videos`)
      : await apiFetch(`/api/videos?search=${encodeURIComponent(params.get("q") || "")}`);
    return { items: result.videos.map(toLegacyVideo) };
  }

  throw new Error(`Unsupported local catalog request: ${resource}`);
}
