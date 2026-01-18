-- 创建分类表
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT DEFAULT '#ff9a56',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建站点表
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  logo TEXT,
  category_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- 插入默认分类
INSERT OR IGNORE INTO categories (name, icon, color, sort_order) VALUES
  ('常用工具', '🛠️', '#ff9a56', 1),
  ('开发资源', '💻', '#ffb347', 2),
  ('设计素材', '🎨', '#ffc875', 3),
  ('学习教程', '📚', '#ffd89b', 4),
  ('娱乐休闲', '🎮', '#ffe4a3', 5);

-- 插入示例站点
INSERT OR IGNORE INTO sites (name, url, description, logo, category_id, sort_order) VALUES
  ('GitHub', 'https://github.com', '全球最大的代码托管平台', 'https://github.githubassets.com/favicons/favicon.svg', 2, 1),
  ('Google', 'https://google.com', '全球最大的搜索引擎', 'https://www.google.com/favicon.ico', 1, 2),
  ('Stack Overflow', 'https://stackoverflow.com', '程序员问答社区', 'https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico', 2, 3);

-- 设置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#6366f1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 站点-标签关联表
CREATE TABLE IF NOT EXISTS site_tags (
  site_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (site_id, tag_id),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- 标签相关索引
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_site_tags_site_id ON site_tags(site_id);
CREATE INDEX IF NOT EXISTS idx_site_tags_tag_id ON site_tags(tag_id);

-- 插入默认背景图
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('background_image', 'https://images.unsplash.com/photo-1484821582734-6c6c9f99a672?q=80&w=2000&auto=format&fit=crop');
