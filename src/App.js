import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, matchPath } from "react-router-dom";
import ReactPlayer from "react-player";
import { Upload as TusUpload } from "tus-js-client";
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CardMedia,
  Checkbox,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";
import HomeIcon from "@mui/icons-material/Home";
import HistoryIcon from "@mui/icons-material/History";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import LiveTvIcon from "@mui/icons-material/LiveTv";
import SubscriptionsIcon from "@mui/icons-material/Subscriptions";
import WorkspacePremiumIcon from "@mui/icons-material/WorkspacePremium";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import { apiFetch, getErrorMessage } from "./utils/api";
import "./index.css";

const categories = ["All", "Music", "Gaming", "Learning", "Technology", "Cooking", "Live"];
const formatCount = (value) => new Intl.NumberFormat().format(Number(value || 0));

function Header({ user, openAuth, refreshUser }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      await refreshUser();
      navigate("/");
    } catch (error) {
      window.alert(getErrorMessage(error));
    }
  }

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    if (value) navigate(`/search/${encodeURIComponent(value)}`);
  }

  return (
    <AppBar position="sticky" color="default" elevation={1} sx={{ background: "#101010", color: "white" }}>
      <Toolbar sx={{ gap: 2, justifyContent: "space-between", flexWrap: "wrap" }}>
        <Link to="/" className="brand">
          <span className="brand-mark">▶</span>
          <Typography variant="h6" component="span" fontWeight={800}>VoxBox</Typography>
        </Link>
        <Box component="form" onSubmit={submitSearch} className="search-form">
          <TextField
            size="small"
            fullWidth
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search videos"
            inputProps={{ "aria-label": "Search videos" }}
          />
          <IconButton type="submit" aria-label="Search" sx={{ color: "white" }}><SearchIcon /></IconButton>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button component={Link} to="/studio" color="inherit" startIcon={<AddCircleOutlineIcon />}>Studio</Button>
          <Button component={Link} to="/premium" color="inherit" startIcon={<WorkspacePremiumIcon />}>Premium</Button>
          {user ? (
            <>
              <Chip avatar={<Avatar>{user.channelName?.[0] || user.email[0].toUpperCase()}</Avatar>} label={user.channelName || user.email} />
              <Button color="inherit" onClick={logout}>Sign out</Button>
            </>
          ) : <Button variant="outlined" onClick={() => openAuth("login")}>Sign in</Button>}
        </Stack>
      </Toolbar>
    </AppBar>
  );
}

function Navigation() {
  const links = [
    { to: "/", label: "Home", icon: <HomeIcon /> },
    { to: "/?sort=live", label: "Live", icon: <LiveTvIcon /> },
    { to: "/subscriptions", label: "Subscriptions", icon: <SubscriptionsIcon /> },
    { to: "/history", label: "History", icon: <HistoryIcon /> },
    { to: "/saved", label: "Watch later", icon: <BookmarkIcon /> },
    { to: "/studio", label: "Your videos", icon: <VideoLibraryIcon /> },
  ];
  return (
    <Box component="nav" className="side-navigation" aria-label="Main navigation">
      {links.map((link) => (
        <Button key={link.to} component={Link} to={link.to} startIcon={link.icon} fullWidth>{link.label}</Button>
      ))}
      <Divider sx={{ my: 2, borderColor: "#333" }} />
      <Typography variant="caption" color="grey.500">
        Personal prototype: uploads, profiles, and subscriptions are local to this server.
      </Typography>
    </Box>
  );
}

function AuthDialog({ open, defaultMode, onClose, onAuthenticated, onVerificationRequired }) {
  const [mode, setMode] = useState(defaultMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", password: "", channelName: "" });

  useEffect(() => {
    if (open) {
      setError("");
      setMode(defaultMode);
    }
  }, [open, defaultMode]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch(`/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (mode === "register" && result.verificationRequired) {
        onVerificationRequired(form.email);
        onClose();
        return;
      }
      await onAuthenticated();
      onClose();
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset() {
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: form.email }) });
      setError(result.message);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/auth/resend-verification", { method: "POST", body: JSON.stringify({ email: form.email }) });
      setError(result.message);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <Box component="form" onSubmit={submit}>
        <DialogTitle>{mode === "login" ? "Sign in" : mode === "register" ? "Create an account" : "Reset your password"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            {mode === "register" && (
              <TextField label="Channel name" autoComplete="nickname" required inputProps={{ maxLength: 60 }}
                value={form.channelName} onChange={(event) => setForm({ ...form, channelName: event.target.value })} />
            )}
            <TextField label="Email" type="email" autoComplete="email" required
              value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            {mode !== "forgot" && <TextField label="Password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"}
              required inputProps={{ minLength: mode === "login" ? 1 : 10 }} helperText={mode === "register" ? "Use at least 10 characters." : undefined}
              value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {mode === "login" && <Button onClick={() => setMode("register")}>Create account</Button>}
          {mode === "register" && <Button onClick={() => setMode("login")}>I already have an account</Button>}
          {mode === "login" && <Button onClick={() => setMode("forgot")}>Forgot password?</Button>}
          {mode === "forgot" && <Button onClick={() => setMode("login")}>Back to sign in</Button>}
          {mode === "forgot"
            ? <Button variant="contained" disabled={busy || !form.email} onClick={requestPasswordReset}>{busy ? "Please wait…" : "Send reset link"}</Button>
            : <Button type="submit" variant="contained" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Register"}</Button>}
          {mode === "login" && /verify your email/i.test(error) && <Button disabled={busy || !form.email} onClick={resendVerification}>Resend verification</Button>}
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function VideoCard({ video }) {
  return (
    <Card className="video-card">
      <CardActionArea component={Link} to={`/video/${video.id}`}>
        <CardMedia component="img" height="190" image={video.thumbnailUrl || "/video-placeholder.svg"} alt="" />
        {video.isLive && <Chip className="live-badge" color="error" size="small" label="LIVE" />}
        <CardContent>
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            <Avatar src={video.channelAvatar || undefined}>{video.channelName?.[0] || "V"}</Avatar>
            <Box minWidth={0}>
              <Typography variant="subtitle1" color="white" fontWeight={700} className="clamp-title">{video.title}</Typography>
              <Typography variant="body2" color="grey.400">{video.channelName}</Typography>
              <Typography variant="caption" color="grey.500">{formatCount(video.views)} views · {new Date(video.createdAt).toLocaleDateString()}</Typography>
            </Box>
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function Catalog({ title, category: categoryFilter, search, sort = "recommended", currentUser, openAuth }) {
  const [videos, setVideos] = useState([]);
  const [categoriesForFilter, setCategoriesForFilter] = useState(categoryFilter || "All");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const query = useMemo(() => {
    const params = new URLSearchParams({ sort });
    if (search) params.set("search", search);
    if (categoriesForFilter !== "All" && categoriesForFilter !== "Live") params.set("category", categoriesForFilter);
    if (categoriesForFilter === "Live" || sort === "live") params.set("sort", "live");
    return params.toString();
  }, [categoriesForFilter, search, sort]);

  useEffect(() => {
    setCategoriesForFilter(search || sort === "live" ? "All" : categoryFilter || "All");
  }, [search, categoryFilter, sort]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    const endpoint = sort === "recommended" && currentUser
      ? "/api/recommendations"
      : `/api/videos?${query}`;
    apiFetch(endpoint)
      .then((data) => { if (!cancelled) setVideos(data.videos); })
      .catch((requestError) => { if (!cancelled) setError(getErrorMessage(requestError)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [query, currentUser, sort]);

  async function loadRecommendations() {
    if (!currentUser) {
      openAuth("login");
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch("/api/recommendations");
      setVideos(data.videos);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1} mb={2}>
        <Typography variant="h4" fontWeight={800}>{title}</Typography>
        {!search && <Button onClick={loadRecommendations}>Refresh recommendations</Button>}
      </Stack>
      {!search && (
        <Stack direction="row" className="category-row" spacing={1} mb={3}>
          {categories.map((item) => (
            <Chip key={item} clickable label={item} color={categoriesForFilter === item ? "error" : "default"}
              onClick={() => setCategoriesForFilter(item)} />
          ))}
        </Stack>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {busy ? <CircularProgress /> : videos.length ? (
        <Box className="video-grid">{videos.map((video) => <VideoCard key={video.id} video={video} />)}</Box>
      ) : <Alert severity="info">No videos found yet. Create an account and publish a video from Studio.</Alert>}
    </Box>
  );
}

function VideoPage({ videoId, user, openAuth }) {
  const id = videoId;
  const [data, setData] = useState(null);
  const [related, setRelated] = useState([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    apiFetch(`/api/videos/${encodeURIComponent(id)}`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        apiFetch(`/api/videos/${encodeURIComponent(id)}/view`, { method: "POST" })
          .catch((requestError) => { if (!cancelled) setError(getErrorMessage(requestError)); });
      })
      .catch((requestError) => { if (!cancelled) setError(getErrorMessage(requestError)); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setRelated([]);
      return () => { cancelled = true; };
    }
    apiFetch("/api/recommendations")
      .then((result) => { if (!cancelled) setRelated(result.videos.filter((video) => video.id !== id).slice(0, 4)); })
      .catch((requestError) => {
        if (!cancelled) console.warn("Could not load personalized recommendations.", requestError);
      });
    return () => { cancelled = true; };
  }, [id, user]);

  async function interact(endpoint, method = "POST", body) {
    if (!user) {
      openAuth("login");
      return;
    }
    try {
      const result = await apiFetch(endpoint, { method, body: body ? JSON.stringify(body) : undefined });
      if (endpoint.endsWith("/like")) setData((current) => ({ ...current, liked: result.liked, video: { ...current.video, likes: result.likes } }));
      else if (endpoint.endsWith("/subscribe")) setData((current) => ({ ...current, subscribed: result.subscribed }));
      else if (endpoint.endsWith("/save")) setData((current) => ({ ...current, saved: result.saved }));
      else if (endpoint.endsWith("/comments")) setData((current) => ({ ...current, comments: result.comments }));
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!comment.trim()) return;
    await interact(`/api/videos/${encodeURIComponent(id)}/comments`, "POST", { text: comment.trim() });
    setComment("");
  }

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <CircularProgress />;
  const { video, comments, liked, subscribed } = data;
  const media = video.playbackUrl || video.streamUrl || video.mediaUrl;

  return (
    <Box className="watch-layout">
      <Box minWidth={0}>
        <Paper className="player-frame">
          <ReactPlayer url={media} controls width="100%" height="100%" playing={false} playsinline />
        </Paper>
        <Typography variant="h5" fontWeight={800} sx={{ mt: 2 }}>{video.title}</Typography>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1} mt={1}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Avatar src={video.channelAvatar || undefined}>{video.channelName?.[0] || "V"}</Avatar>
            <Box><Typography fontWeight={700}>{video.channelName}</Typography><Typography variant="caption" color="grey.500">{formatCount(video.subscribers)} subscribers</Typography></Box>
            <Button variant="contained" onClick={() => interact(`/api/channels/${encodeURIComponent(video.channelId)}/subscribe`)}>
              {subscribed ? "Subscribed" : "Subscribe"}
            </Button>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={() => interact(`/api/videos/${encodeURIComponent(id)}/like`)}>{liked ? "♥" : "♡"} {formatCount(video.likes)}</Button>
            <Button variant="outlined" onClick={() => interact(`/api/videos/${encodeURIComponent(id)}/save`)}>{data.saved ? "Saved" : "Save"}</Button>
          </Stack>
        </Stack>
        <Paper sx={{ p: 2, mt: 2, bgcolor: "#222" }}>
          <Typography variant="body2" color="grey.400">{formatCount(video.views)} views · {new Date(video.createdAt).toLocaleDateString()} · {video.category}</Typography>
          <Typography sx={{ whiteSpace: "pre-wrap", mt: 1 }}>{video.description || "No description provided."}</Typography>
        </Paper>
        <Box mt={4}>
          <Typography variant="h6" fontWeight={700}>{comments.length} comments</Typography>
          <Box component="form" onSubmit={submitComment} className="comment-form">
            <TextField fullWidth size="small" value={comment} onChange={(event) => setComment(event.target.value)}
              placeholder={user ? "Add a comment…" : "Sign in to comment"} disabled={!user} inputProps={{ maxLength: 2000 }} />
            <Button type="submit" variant="contained" disabled={!user || !comment.trim()}>Comment</Button>
          </Box>
          {comments.map((item) => <Paper key={item.id} sx={{ p: 1.5, mb: 1, bgcolor: "#1b1b1b" }}>
            <Typography fontWeight={700}>{item.channelName}</Typography><Typography>{item.text}</Typography>
          </Paper>)}
        </Box>
      </Box>
      <Stack spacing={2}>{related.map((item) => <VideoCard key={item.id} video={item} />)}</Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Box>
  );
}

function Library({ endpoint, title, user, openAuth }) {
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!user) {
      setVideos([]);
      return;
    }
    setError("");
    apiFetch(endpoint).then((result) => setVideos(result.videos)).catch((requestError) => setError(getErrorMessage(requestError)));
  }, [endpoint, user]);
  if (!user) return <Alert severity="info" action={<Button onClick={() => openAuth("login")}>Sign in</Button>}>Sign in to view your {title.toLowerCase()}.</Alert>;
  if (error) return <Alert severity="warning" action={<Button onClick={() => openAuth("login")}>Sign in</Button>}>{error}</Alert>;
  return <><Typography variant="h4" fontWeight={800} mb={2}>{title}</Typography><Box className="video-grid">{videos.map((video) => <VideoCard key={video.id} video={video} />)}</Box>{!videos.length && <Alert severity="info">Nothing here yet.</Alert>}</>;
}

function Studio({ user, openAuth }) {
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [muxConfigured, setMuxConfigured] = useState(false);
  const [ingestInfo, setIngestInfo] = useState(null);
  const formRef = useRef(null);
  const [form, setForm] = useState({ title: "", description: "", category: "Education", visibility: "public", isLive: false, streamUrl: "" });

  const refresh = () => apiFetch("/api/studio/videos").then((result) => setVideos(result.videos));
  useEffect(() => {
    if (user) {
      refresh().catch((requestError) => setError(getErrorMessage(requestError)));
      apiFetch("/api/health").then((health) => setMuxConfigured(health.muxConfigured)).catch((requestError) => setError(getErrorMessage(requestError)));
    }
  }, [user]);

  async function upload(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setUploadProgress(0);
    const formElement = event.currentTarget;
    try {
      const body = new FormData(formElement);
      body.set("isLive", String(form.isLive));
      const file = body.get("video");
      if (file instanceof File && file.size > 0 && muxConfigured) {
        const { upload } = await apiFetch("/api/studio/mux/uploads", {
          method: "POST",
          body: JSON.stringify({
            title: form.title,
            description: form.description,
            category: form.category,
            visibility: form.visibility,
          }),
        });
        await new Promise((resolve, reject) => {
          const tusUpload = new TusUpload(file, {
            uploadUrl: upload.url,
            chunkSize: 8 * 1024 * 1024,
            retryDelays: [0, 1000, 3000, 5000],
            metadata: { filename: file.name, filetype: file.type || "application/octet-stream" },
            onProgress: (sent, total) => setUploadProgress(Math.round((sent / total) * 100)),
            onSuccess: resolve,
            onError: reject,
          });
          tusUpload.start();
        });
      } else {
        await apiFetch("/api/studio/videos", { method: "POST", body });
      }
      formElement.reset();
      setForm({ title: "", description: "", category: "Education", visibility: "public", isLive: false, streamUrl: "" });
      setNotice(muxConfigured && file instanceof File && file.size > 0
        ? "Upload complete. Mux is processing your video; it will appear in the catalog when ready."
        : "Your video was added to the catalog.");
      await refresh();
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function createLiveStream() {
    setBusy(true);
    setError("");
    setNotice("");
    setIngestInfo(null);
    try {
      const result = await apiFetch("/api/studio/live-streams", {
        method: "POST",
        body: JSON.stringify({ title: form.title, description: form.description, category: form.category, visibility: form.visibility }),
      });
      setIngestInfo({ ...result.ingest, videoId: result.video.id });
      setNotice("RTMP stream created. Copy the stream key now; it is not stored or shown again.");
      await refresh();
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function rotateStreamKey(video) {
    if (!window.confirm("Rotate this stream key? The current key will stop working.")) return;
    setBusy(true);
    setError("");
    setIngestInfo(null);
    try {
      const result = await apiFetch(`/api/studio/live-streams/${encodeURIComponent(video.id)}/rotate-key`, { method: "POST" });
      setIngestInfo({ ...result.ingest, videoId: video.id });
      setNotice("Stream key rotated. Copy the new key now; it is not stored or shown again.");
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function updateVisibility(video, visibility) {
    try {
      await apiFetch(`/api/studio/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: JSON.stringify({ visibility }) });
      await refresh();
    } catch (requestError) { setError(getErrorMessage(requestError)); }
  }

  async function deleteVideo(video) {
    if (!window.confirm(`Delete "${video.title}" permanently?`)) return;
    try {
      await apiFetch(`/api/studio/videos/${encodeURIComponent(video.id)}`, { method: "DELETE" });
      await refresh();
    } catch (requestError) { setError(getErrorMessage(requestError)); }
  }

  if (!user) return <Alert severity="info" action={<Button onClick={() => openAuth("login")}>Sign in</Button>}>Sign in to open your creator Studio.</Alert>;

  return (
    <Box>
      <Typography variant="h4" fontWeight={800} mb={2}>Creator Studio</Typography>
      <Typography color="grey.400" mb={3}>{muxConfigured ? "Videos upload directly to Mux for transcoding and CDN delivery. Create a live stream to receive an RTMP ingest key." : "Upload a video file or add an externally hosted HTTPS HLS stream to the catalog."}</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}
      {ingestInfo && <Paper sx={{ p: 2, mb: 2, bgcolor: "#242424" }}>
        <Typography fontWeight={700} mb={1}>RTMP ingest — copy now</Typography>
        <TextField fullWidth label="Server URL" value={ingestInfo.url} InputProps={{ readOnly: true }} sx={{ mb: 1 }} />
        <TextField fullWidth label="Stream key (shown once)" value={ingestInfo.streamKey} InputProps={{ readOnly: true }} />
        <Button sx={{ mt: 1 }} onClick={() => navigator.clipboard.writeText(`${ingestInfo.url}\n${ingestInfo.streamKey}`)}>Copy ingest details</Button>
      </Paper>}
      <Paper component="form" ref={formRef} onSubmit={upload} sx={{ p: 2, mb: 4, bgcolor: "#1b1b1b" }}>
        <Stack spacing={2}>
          <Typography variant="h6">Publish content</Typography>
          <TextField name="title" label="Title" required inputProps={{ maxLength: 160 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <TextField name="description" label="Description" multiline minRows={3} inputProps={{ maxLength: 10000 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <TextField name="category" select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} sx={{ minWidth: 180 }}>
              {categories.filter((category) => category !== "All" && category !== "Live").map((category) => <MenuItem key={category} value={category}>{category}</MenuItem>)}
            </TextField>
            <TextField name="visibility" select label="Visibility" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} sx={{ minWidth: 180 }}>
              {["public", "unlisted", "private"].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
            </TextField>
            <Button component="label" variant="outlined">{muxConfigured ? "Choose video file" : "Choose video"}<input name="video" type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg" hidden /></Button>
          </Stack>
          <Divider />
            <FormControlLabel control={<Checkbox checked={form.isLive} onChange={(e) => setForm({ ...form, isLive: e.target.checked })} />}
                label={muxConfigured ? "Add an externally hosted HLS stream instead of creating an RTMP stream" : "Add an externally hosted live stream to the live catalog"} />
            {form.isLive && <TextField name="streamUrl" label="HTTPS HLS manifest (.m3u8)" placeholder="https://stream.example.com/channel/index.m3u8" required
              value={form.streamUrl} onChange={(e) => setForm({ ...form, streamUrl: e.target.value })} />}
            {busy && uploadProgress > 0 && <Typography variant="body2">Uploading to Mux: {uploadProgress}%</Typography>}
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <Button type="submit" variant="contained" disabled={busy}>{busy ? "Publishing…" : "Publish video / HLS stream"}</Button>
              {muxConfigured && !form.isLive && <Button type="button" variant="outlined" disabled={busy} onClick={createLiveStream}>Create RTMP live stream</Button>}
            </Stack>
        </Stack>
      </Paper>
      <Typography variant="h6" mb={2}>Your videos ({videos.length})</Typography>
      <Stack spacing={1}>
        {videos.map((video) => <Paper key={video.id} sx={{ p: 1.5, bgcolor: "#1b1b1b" }}>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1} alignItems={{ md: "center" }}>
            <Box><Typography fontWeight={700}>{video.title}</Typography><Typography variant="caption" color="grey.400">{video.visibility} · {formatCount(video.views)} views · {video.isLive ? "Live stream" : "Video"} · {video.processingStatus}</Typography></Box>
            <Stack direction="row" spacing={1} alignItems="center">
              {video.muxPlaybackId && video.isLive && <Button disabled={busy} onClick={() => rotateStreamKey(video)}>Rotate RTMP key</Button>}
              <TextField select size="small" label="Visibility" value={video.visibility} onChange={(e) => updateVisibility(video, e.target.value)}>
                {["public", "unlisted", "private"].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
              </TextField>
              <Button color="error" onClick={() => deleteVideo(video)}>Delete</Button>
            </Stack>
          </Stack>
        </Paper>)}
      </Stack>
    </Box>
  );
}

function Premium({ user, openAuth }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { apiFetch("/api/billing/status").then(setStatus).catch((requestError) => setError(getErrorMessage(requestError))); }, []);

  async function checkout() {
    if (!user) {
      openAuth("register");
      return;
    }
    setError("");
    try {
      const result = await apiFetch("/api/billing/checkout", { method: "POST" });
      window.location.assign(result.url);
    } catch (requestError) { setError(getErrorMessage(requestError)); }
  }

  async function manage() {
    try {
      const result = await apiFetch("/api/billing/portal", { method: "POST" });
      window.location.assign(result.url);
    } catch (requestError) { setError(getErrorMessage(requestError)); }
  }

  return (
    <Container maxWidth="md">
      <Paper sx={{ p: { xs: 3, md: 6 }, mt: 3, bgcolor: "#1b1b1b", textAlign: "center" }}>
        <WorkspacePremiumIcon color="error" sx={{ fontSize: 48 }} />
        <Typography variant="h3" fontWeight={800} mb={2}>VoxBox Premium</Typography>
        <Typography color="grey.300" mb={3}>Support this independent video platform with a recurring subscription managed by Stripe.</Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {status?.isPremium && <Alert severity="success" sx={{ mb: 2 }}>Premium is active on this account.</Alert>}
        {status?.configured === false && <Alert severity="info" sx={{ mb: 2 }}>Billing is not configured. The administrator must set the matching Stripe {status?.mode || "test"} secret key, recurring price, and webhook secret.</Alert>}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} justifyContent="center">
          {status?.isPremium
            ? <Button variant="contained" onClick={manage}>Manage subscription</Button>
            : <Button variant="contained" onClick={checkout} disabled={status?.configured === false}>Subscribe</Button>}
        </Stack>
        <Typography variant="caption" display="block" color="grey.500" mt={3}>Subscriptions are created and managed through Stripe Checkout and the customer portal.</Typography>
      </Paper>
    </Container>
  );
}

function VerifyEmailPage({ openAuth }) {
  const { search } = useLocation();
  const token = new URLSearchParams(search).get("token");
  const [state, setState] = useState({ busy: true, error: "" });
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ busy: false, error: "This verification link is missing its token." });
      return () => { cancelled = true; };
    }
    apiFetch("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => { if (!cancelled) setState({ busy: false, error: "" }); })
      .catch((error) => { if (!cancelled) setState({ busy: false, error: getErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [token]);
  if (state.busy) return <CircularProgress />;
  return <Paper sx={{ p: 4, bgcolor: "#1b1b1b" }}>
    {state.error
      ? <Alert severity="error">{state.error}</Alert>
      : <Alert severity="success">Your email is verified. You can now sign in.</Alert>}
    {!state.error && <Button sx={{ mt: 2 }} variant="contained" onClick={() => openAuth("login")}>Sign in</Button>}
  </Paper>;
}

function ResetPasswordPage({ openAuth }) {
  const { search } = useLocation();
  const token = new URLSearchParams(search).get("token");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
      setComplete(true);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }
  return <Paper component="form" onSubmit={submit} sx={{ p: 4, maxWidth: 480, mx: "auto", bgcolor: "#1b1b1b" }}>
    <Typography variant="h5" fontWeight={800} mb={2}>Choose a new password</Typography>
    {complete
      ? <><Alert severity="success">Your password has been updated. Other sessions have been signed out.</Alert><Button sx={{ mt: 2 }} variant="contained" onClick={() => openAuth("login")}>Sign in</Button></>
      : <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label="New password" type="password" required inputProps={{ minLength: 10 }} value={password} onChange={(event) => setPassword(event.target.value)} />
        <TextField label="Confirm password" type="password" required inputProps={{ minLength: 10 }} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        <Button type="submit" variant="contained" disabled={busy || !token}>{busy ? "Saving…" : "Update password"}</Button>
      </Stack>}
  </Paper>;
}

function RouteContent({ user, openAuth }) {
  const { pathname, search } = useLocation();
  const query = new URLSearchParams(search);
  const videoMatch = matchPath("/video/:id", pathname);
  const searchMatch = matchPath("/search/:searchTerm", pathname);
  if (videoMatch) return <VideoPage key={videoMatch.params.id} videoId={videoMatch.params.id} user={user} openAuth={openAuth} />;
  if (searchMatch) {
    const searchTerm = searchMatch.params.searchTerm || "";
    return <Catalog title={`Search results for “${searchTerm}”`} search={searchTerm} currentUser={user} openAuth={openAuth} />;
  }
  if (pathname === "/") return <Catalog title={query.get("sort") === "live" ? "Live now" : "Recommended for you"} sort={query.get("sort") || "recommended"} currentUser={user} openAuth={openAuth} />;
  if (pathname === "/shorts") return <Catalog title="Short videos" sort="recent" currentUser={user} openAuth={openAuth} />;
  if (pathname === "/subscriptions") return <Library endpoint="/api/subscriptions" title="Subscriptions" user={user} openAuth={openAuth} />;
  if (pathname === "/history") return <Library endpoint="/api/history" title="Watch history" user={user} openAuth={openAuth} />;
  if (pathname === "/saved") return <Library endpoint="/api/saved" title="Watch later" user={user} openAuth={openAuth} />;
  if (pathname === "/studio") return <Studio user={user} openAuth={openAuth} />;
  if (pathname === "/premium") return <Premium user={user} openAuth={openAuth} />;
  if (pathname === "/verify-email") return <VerifyEmailPage openAuth={openAuth} />;
  if (pathname === "/reset-password") return <ResetPasswordPage openAuth={openAuth} />;
  return <Alert severity="warning">Page not found. <Button component={Link} to="/">Go home</Button></Alert>;
}

function AppShell() {
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [sessionError, setSessionError] = useState("");
  const [accountNotice, setAccountNotice] = useState("");

  async function refreshUser() {
    try {
      const result = await apiFetch("/api/auth/me");
      setUser(result.user);
      setSessionError("");
      return result.user;
    } catch (error) {
      setUser(null);
      setSessionError(getErrorMessage(error));
      return null;
    }
  }

  useEffect(() => {
    refreshUser();
  }, []);

  function openAuth(mode = "login") {
    setAuthMode(mode);
    setAuthOpen(true);
  }

  return (
    <Box minHeight="100vh" bgcolor="#0f0f0f" color="white">
      <Header user={user} openAuth={openAuth} refreshUser={refreshUser} />
      {sessionError && <Alert severity="error" action={<Button onClick={refreshUser}>Retry</Button>}>Account service unavailable: {sessionError}</Alert>}
      {accountNotice && <Alert severity="info" onClose={() => setAccountNotice("")}>{accountNotice}</Alert>}
      <Box className="app-layout">
        <Navigation />
        <Container component="main" maxWidth={false} sx={{ py: 3, px: { xs: 2, md: 3 } }}>
          <Routes>
            <Route path="*" element={<RouteContent user={user} openAuth={openAuth} />} />
          </Routes>
        </Container>
      </Box>
      <AuthDialog open={authOpen} defaultMode={authMode} onClose={() => setAuthOpen(false)} onAuthenticated={refreshUser}
        onVerificationRequired={(email) => setAccountNotice(`A verification link was sent to ${email}. Verify your email before signing in.`)} />
    </Box>
  );
}

export default function App() {
  return <BrowserRouter><AppShell /></BrowserRouter>;
}
