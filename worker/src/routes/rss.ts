import { Hono } from "hono";
import type { Env } from "../types";
import { findUserByUsername } from "../db/user";
import * as memoDB from "../db/memo";
import * as settingDB from "../db/setting";

export const rssRoutes = new Hono<{ Bindings: Env }>();
export const exploreRssRoutes = new Hono<{ Bindings: Env }>();

interface RssCreator {
  id: number;
  username: string;
  nickname: string;
}

/**
 * 安全转义 XML 特殊字符
 */
function escapeXml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 从内容中提取标题
 */
function getMemoTitle(content: string): string {
  if (!content) return "Untitled";
  
  // 移除 HTML 标签
  const plainText = content.replace(/<[^>]*>/g, '');
  let title = plainText.split("\n")[0]?.replace(/^#+\s*/, "").trim();
  
  if (!title) return "Untitled";
  
  // 安全截断，避免破坏 emoji 等特殊字符
  if (title.length > 100) {
    const truncated = title.slice(0, 100);
    // 检查最后一个字符是否是代理对的一部分（emoji 等）
    if (/[\uD800-\uDBFF]/.test(truncated.slice(-1))) {
      return truncated.slice(0, -1);
    }
    return truncated;
  }
  return title;
}

/**
 * 获取实例标题
 */
async function getInstanceTitle(db: D1Database): Promise<string> {
  const setting = await settingDB.getInstanceSetting(db, "GENERAL");
  if (!setting) {
    return "Memos";
  }

  try {
    const parsed = JSON.parse(setting.value) as { customProfile?: { title?: unknown } };
    const title = typeof parsed.customProfile?.title === "string" ? parsed.customProfile.title.trim() : "";
    return title || "Memos";
  } catch {
    return "Memos";
  }
}

/**
 * 解析创建者信息
 */
async function resolveCreators(db: D1Database, memos: memoDB.MemoRow[]): Promise<Map<number, RssCreator>> {
  const creatorIds = [...new Set(memos.map((memo) => memo.creator_id))];
  const creatorMap = new Map<number, RssCreator>();
  
  if (creatorIds.length === 0) {
    return creatorMap;
  }

  const placeholders = creatorIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT id, username, nickname FROM user WHERE id IN (${placeholders})`)
    .bind(...creatorIds)
    .all<RssCreator>();

  for (const creator of results) {
    creatorMap.set(creator.id, creator);
  }
  
  return creatorMap;
}

/**
 * 生成单个 RSS item
 */
function generateRSSItem(
  title: string,
  link: string,
  pubDate: string,
  description: string,
  contentEncoded: string,
  author?: string,
  guid?: string
): string {
  const itemGuid = guid || link;
  
  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${itemGuid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
      <content:encoded><![CDATA[${contentEncoded}]]></content:encoded>
      ${author ? `<author>${escapeXml(author)}</author>` : ""}
    </item>`;
}

// 用户个人 RSS 路由
rssRoutes.get("/:username/rss.xml", async (c) => {
  const username = c.req.param("username");
  
  // 查找用户
  const user = await findUserByUsername(c.env.DB, username);
  if (!user) {
    return c.text("User not found", 404);
  }

  // 获取用户的公开 memos
  const { memos } = await memoDB.listMemos(c.env.DB, {
    creatorId: user.id,
    visibility: "PUBLIC",
    rowStatus: "NORMAL",
    excludeComments: true,
    pageSize: 50,
    offset: 0,
    orderBy: "created_ts desc",
  });

  // 构建 base URL
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const feedUrl = `${baseUrl}/u/${username}/rss.xml`;
  const now = new Date().toUTCString();

  const items = memos.map((memo) => {
    const title = getMemoTitle(memo.content);
    const pubDate = new Date(memo.created_ts * 1000).toUTCString();
    const link = `${baseUrl}/memos/${memo.uid}`;
    const description = memo.content.substring(0, 500); // 限制描述长度
    
    return generateRSSItem(
      title,
      link,
      pubDate,
      description,
      memo.content,
      user.nickname || user.username,
      undefined
    );
  });

  const instanceName = await getInstanceTitle(c.env.DB);
  const profileName = user.nickname || user.username;
  
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(profileName)} - ${escapeXml(instanceName)}</title>
    <link>${baseUrl}/u/${username}</link>
    <description>${escapeXml(profileName)} 的公开备忘录</description>
    <language>zh-CN</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=600",
  });
});

// 全局探索 RSS 路由
exploreRssRoutes.get("/rss.xml", async (c) => {
  try {
    // 获取所有公开 memos
    const { memos } = await memoDB.listMemos(c.env.DB, {
      visibility: "PUBLIC",
      rowStatus: "NORMAL",
      excludeComments: true,
      pageSize: 50,
      offset: 0,
      orderBy: "created_ts desc",
    });

    if (!memos || memos.length === 0) {
      // 返回空的 RSS feed
      const url = new URL(c.req.url);
      const baseUrl = `${url.protocol}//${url.host}`;
      const feedUrl = `${baseUrl}/explore/rss.xml`;
      const now = new Date().toUTCString();
      const instanceName = await getInstanceTitle(c.env.DB);
      
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(instanceName)} - Explore</title>
    <link>${baseUrl}/explore</link>
    <description>暂无公开备忘录</description>
    <language>zh-CN</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
  </channel>
</rss>`;
      
      return c.body(emptyXml, 200, {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
    }

    // 解析创建者信息
    const creatorMap = await resolveCreators(c.env.DB, memos);
    
    // 构建 base URL - 修复 URL 构建问题
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const feedUrl = `${baseUrl}/explore/rss.xml`;
    const now = new Date().toUTCString();

    // 验证 baseUrl 是否有效
    if (!baseUrl || baseUrl === 'https://http' || baseUrl === 'http://http') {
      console.error('Invalid baseUrl detected:', baseUrl, 'Request URL:', c.req.url);
      return c.text('Invalid request configuration', 500);
    }

    // 生成 RSS items
    const items = memos.map((memo) => {
      const creator = creatorMap.get(memo.creator_id);
      const creatorName = creator?.nickname || creator?.username || `User ${memo.creator_id}`;
      const title = `${creatorName}: ${getMemoTitle(memo.content)}`;
      const pubDate = new Date(memo.created_ts * 1000).toUTCString();
      const link = `${baseUrl}/memos/${memo.uid}`;
      const description = memo.content.substring(0, 500); // 描述用纯文本前500字
      
      return generateRSSItem(
        title,
        link,
        pubDate,
        description,
        memo.content,
        creatorName,
        undefined
      );
    });

    const instanceName = await getInstanceTitle(c.env.DB);
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(instanceName)} - 探索</title>
    <link>${baseUrl}/explore</link>
    <description>来自所有用户的公开备忘录</description>
    <language>zh-CN</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

    return c.body(xml, 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=600", // 缓存10分钟
    });
  } catch (error) {
    console.error("Failed to generate RSS feed:", error);
    return c.text("Internal Server Error", 500);
  }
});

// 如果需要支持内容协商，可以添加 JSON Feed 格式
exploreRssRoutes.get("/feed.json", async (c) => {
  try {
    const { memos } = await memoDB.listMemos(c.env.DB, {
      visibility: "PUBLIC",
      rowStatus: "NORMAL",
      excludeComments: true,
      pageSize: 50,
      offset: 0,
      orderBy: "created_ts desc",
    });

    const creatorMap = await resolveCreators(c.env.DB, memos);
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const instanceName = await getInstanceTitle(c.env.DB);
    const now = new Date().toISOString();

    const items = memos.map((memo) => {
      const creator = creatorMap.get(memo.creator_id);
      const creatorName = creator?.nickname || creator?.username || `User ${memo.creator_id}`;
      
      return {
        id: memo.uid,
        url: `${baseUrl}/memos/${memo.uid}`,
        title: `${creatorName}: ${getMemoTitle(memo.content)}`,
        content_html: memo.content,
        date_published: new Date(memo.created_ts * 1000).toISOString(),
        author: {
          name: creatorName,
        },
      };
    });

    const feed = {
      version: "https://jsonfeed.org/version/1.1",
      title: `${instanceName} - Explore`,
      home_page_url: `${baseUrl}/explore`,
      feed_url: `${baseUrl}/explore/feed.json`,
      description: "Public memos from all users",
      items: items,
    };

    return c.json(feed, 200, {
      "Cache-Control": "public, max-age=600",
    });
  } catch (error) {
    console.error("Failed to generate JSON feed:", error);
    return c.text("Internal Server Error", 500);
  }
});
