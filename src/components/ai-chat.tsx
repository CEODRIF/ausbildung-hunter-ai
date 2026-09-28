"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Conversation, ChatMessage } from "@/lib/ai-service";

export function AIChat({
  conversations: initialConversations,
  selectedConversation,
  initialMessages,
}: {
  conversations: Conversation[];
  selectedConversation: Conversation;
  initialMessages: ChatMessage[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<
    Array<{
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }>
  >([]);
  const [streaming, setStreaming] = useState(false);
  const router = useRouter();
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);
  const quickActions = [
    "Analyze my CV",
    "Improve my Bewerbung",
    "Write an Anschreiben",
    "Translate my application into German",
    "Prepare me for an interview",
    "Analyze a job advertisement",
  ];
  const selectConversation = (id: string) =>
    router.push(`/ai?conversation=${id}`);
  const createNew = async () => {
    const response = await fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const conversation = await response.json();
    if (response.ok) {
      setConversations((items) => [conversation, ...items]);
      router.push(`/ai?conversation=${conversation.id}`);
    }
  };
  const removeConversation = async (id: string) => {
    const response = await fetch("/api/ai/conversations", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (response.ok) {
      setConversations((items) => items.filter((item) => item.id !== id));
      if (id === selectedConversation.id) router.push("/ai");
    }
  };
  const upload = async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/ai/files", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed.");
    setFiles((items) => [...items, result]);
  };
  const send = async () => {
    if ((!input.trim() && !files.length) || streaming) return;
    setError("");
    setStreaming(true);
    const userContent = input.trim() || "Please analyze the attached file(s).";
    setMessages((items) => [
      ...items,
      {
        id: `local-${Date.now()}`,
        conversation_id: selectedConversation.id,
        user_id: "",
        role: "user",
        content: userContent,
        created_at: new Date().toISOString(),
      },
    ]);
    setInput("");
    const assistantId = `assistant-${Date.now()}`;
    setMessages((items) => [
      ...items,
      {
        id: assistantId,
        conversation_id: selectedConversation.id,
        user_id: "",
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
      },
    ]);
    abortRef.current = new AbortController();
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: selectedConversation.id,
          content: userContent,
          fileIds: files.map((file) => file.id),
        }),
        signal: abortRef.current.signal,
      });
      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "AI request failed.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let complete = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        complete += decoder.decode(value, { stream: true });
        setMessages((items) =>
          items.map((message) =>
            message.id === assistantId
              ? { ...message, content: complete }
              : message,
          ),
        );
      }
      setFiles([]);
    } catch (sendError) {
      if ((sendError as Error).name !== "AbortError")
        setError(
          sendError instanceof Error ? sendError.message : "AI request failed.",
        );
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };
  return (
    <div className="flex min-h-[calc(100vh-72px)] bg-[#f6f8fb]">
      <aside
        className={`${drawer ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-40 w-72 border-r border-[#e5ebf3] bg-white p-5 transition-transform lg:static lg:translate-x-0`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#1d3458]">Conversations</h2>
          <button
            className="text-xl text-[#8290a4] lg:hidden"
            onClick={() => setDrawer(false)}
          >
            ×
          </button>
        </div>
        <button
          onClick={() => void createNew()}
          className="mt-5 flex h-10 w-full items-center justify-center rounded-xl bg-[#2f6fed] text-xs font-bold text-white"
        >
          ＋ New conversation
        </button>
        <div className="mt-5 space-y-1">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              onClick={() => selectConversation(conversation.id)}
              className={`flex w-full items-center rounded-xl px-3 py-3 text-left text-xs font-semibold ${conversation.id === selectedConversation.id ? "bg-[#edf3ff] text-[#2f6fed]" : "text-[#6d7d96] hover:bg-[#f6f8fb]"}`}
            >
              <span className="min-w-0 flex-1 truncate">
                {conversation.title}
              </span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Delete ${conversation.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeConversation(conversation.id);
                }}
                className="ml-2 text-[#a0adbd] hover:text-[#d9535d]"
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <Link
          href="/dashboard"
          className="absolute bottom-5 left-5 text-xs font-semibold text-[#8290a4]"
        >
          ← Dashboard
        </Link>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-[#e5ebf3] bg-white px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <button
              className="rounded-lg border border-[#dfe6f0] px-2 py-1 text-[#546783] lg:hidden"
              onClick={() => setDrawer(true)}
            >
              ☰
            </button>
            <div>
              <h1 className="text-sm font-bold text-[#1d3458]">AI Assistant</h1>
              <p className="text-[11px] text-[#8b9ab0]">
                Your career-document workspace
              </p>
            </div>
          </div>
          <Link
            href="/settings/usage"
            className="text-xs font-semibold text-[#2f6fed]"
          >
            Usage
          </Link>
        </header>
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 py-8 sm:px-8"
        >
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 ? (
              <div className="py-12 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#edf3ff] text-xl font-bold text-[#2f6fed]">
                  AI
                </div>
                <h2 className="mt-6 text-2xl font-bold tracking-[-0.04em] text-[#10203b]">
                  How can I help with your next chapter?
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#71819a]">
                  Ask about your Bewerbungen, CV, Anschreiben, interviews, or
                  uploaded career documents.
                </p>
                <div className="mt-8 grid gap-2 sm:grid-cols-2">
                  {quickActions.map((action) => (
                    <button
                      key={action}
                      onClick={() => setInput(action)}
                      className="rounded-xl border border-[#e2e8f1] bg-white px-4 py-3 text-left text-xs font-semibold text-[#546783] hover:border-[#b9c9e2] hover:bg-[#f8faff]"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "user" ? "bg-[#2f6fed] text-white" : "border border-[#e7ecf3] bg-white text-[#1d3458]"}`}
                    >
                      {message.role === "assistant" && !message.content ? (
                        <span className="text-[#8290a4]">
                          AI is thinking...
                        </span>
                      ) : message.role === "assistant" ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      ) : (
                        message.content
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <div className="mt-5 rounded-xl border border-[#f5d7da] bg-[#fff8f8] px-4 py-3 text-sm text-[#a3404b]">
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-[#e5ebf3] bg-white px-5 py-4 sm:px-8">
          <div className="mx-auto max-w-3xl">
            <div className="mb-3 flex flex-wrap gap-2">
              {files.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#edf3ff] px-2.5 py-1.5 text-xs font-semibold text-[#2f6fed]"
                >
                  {file.filename}
                  <button
                    onClick={async () => {
                      await fetch("/api/ai/files", {
                        method: "DELETE",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ fileId: file.id }),
                      });
                      setFiles((items) =>
                        items.filter((item) => item.id !== file.id),
                      );
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-end gap-2 rounded-2xl border border-[#dfe6f0] bg-[#fbfcfe] p-2 focus-within:border-[#2f6fed] focus-within:ring-4 focus-within:ring-[#2f6fed]/10">
              <button
                type="button"
                aria-label="Attach files"
                onClick={() => fileRef.current?.click()}
                className="rounded-xl p-3 text-lg text-[#71819a] hover:bg-[#edf3ff] hover:text-[#2f6fed]"
              >
                ＋
                <input
                  ref={fileRef}
                  className="hidden"
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp"
                  onChange={async (event) => {
                    for (const file of Array.from(event.target.files ?? [])) {
                      try {
                        await upload(file);
                      } catch (uploadError) {
                        setError(
                          uploadError instanceof Error
                            ? uploadError.message
                            : "Upload failed.",
                        );
                      }
                    }
                    event.target.value = "";
                  }}
                />
              </button>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask about your career documents..."
                rows={1}
                className="max-h-32 min-h-11 flex-1 resize-none bg-transparent px-2 py-3 text-sm text-[#1d3458] outline-none placeholder:text-[#a0adbd]"
              />
              <button
                type="button"
                onClick={() =>
                  streaming ? abortRef.current?.abort() : void send()
                }
                className="rounded-xl bg-[#2f6fed] px-4 py-3 text-xs font-bold text-white hover:bg-[#255dcc] disabled:opacity-50"
              >
                {streaming ? "Stop" : "Send"}
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-[#a0adbd]">
              AI suggestions should be reviewed before use.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
