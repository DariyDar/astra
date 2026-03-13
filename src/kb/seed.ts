#!/usr/bin/env node
/**
 * Seed the KB entity graph from the AstroCat Master Document v2.
 * Run: npx tsx src/kb/seed.ts
 *
 * Idempotent — skips existing entities (onConflictDoNothing).
 * This is the INITIAL vector, not the ultimate truth.
 * Entity graph grows through nightly ingestion/extraction.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../db/schema.js'
import { createEntity, addAlias, addRelation } from './repository.js'
import type { EntityType, RelationType } from './types.js'

const { Pool } = pg

export interface SeedEntity {
  type: EntityType
  name: string
  company?: string
  aliases?: string[]
  metadata?: Record<string, unknown>
}

export interface SeedRelation {
  from: string
  to: string
  relation: RelationType
  role?: string
}

// ── Companies ──

export const companies: SeedEntity[] = [
  { type: 'company', name: 'Highground', aliases: ['HG', 'HighGround', 'Хайграунд', 'High Ground'] },
  { type: 'company', name: 'AstroCat', aliases: ['AC', 'Астрокэт', 'Астрокат', 'Astro Cat'] },
  { type: 'company', name: 'Tilting Point', aliases: ['TP'] },
  { type: 'company', name: 'Relevate Health', aliases: ['Level Ex', 'Relevate Healt'] },
  { type: 'company', name: 'Ohbibi' },
  { type: 'company', name: 'Beamable' },
  { type: 'company', name: 'Indium Soft' },
  { type: 'company', name: 'SNKE', aliases: ['SNKE ex Level Ex'] },
]

// ── Projects ──

export const projects: SeedEntity[] = [
  { type: 'project', name: 'Level One', company: 'hg', aliases: ['L1', 'Левел Ван', 'LEV1', 'LVL1', 'Gluc', 'Глюк'], metadata: { client: 'Relevate Health' } },
  { type: 'project', name: 'Level Two', company: 'hg', aliases: ['L2', 'Левел Ту', 'LEV2', 'LVL2'], metadata: { client: 'Relevate Health' } },
  { type: 'project', name: 'Pivot Pumps', company: 'hg', aliases: ['Помпы', 'Пивот', 'PIVOT PUMPS'], metadata: { client: 'Relevate Health' } },
  { type: 'project', name: 'HTML5 Banners', company: 'hg', aliases: ['HTML5 баннеры', 'баннеры', 'Баннеры', 'HTML5 banners'], metadata: { client: 'Relevate Health' } },
  { type: 'project', name: 'Playable Ads', company: 'hg', aliases: ['Playable Advertisement', 'плейаблы', 'Playable'], metadata: { client: 'Relevate Health' } },
  { type: 'project', name: 'Star Trek Timelines', company: 'ac', aliases: ['STT', 'Стар Трек', 'стт', 'СТТ'], metadata: { client: 'Tilting Point' } },
  { type: 'project', name: 'SpongeBob: Krusty Cook-Off', company: 'ac', aliases: ['SpongeBob', 'SBKCO', 'Губка Боб', 'SB', 'KCO', 'SpongeBob LiveOps', 'SBKCO F2P', 'Krusty Cook-Off', 'SBLO'], metadata: { client: 'Tilting Point', description: 'SpongeBob F2P mobile game (LiveOps)' } },
  { type: 'project', name: 'SpongeBob Get Cookin\'', company: 'ac', aliases: ['SB Netflix', 'SpongeBob Netflix', 'SpongeBob PE', 'SpongeBob KCO Netflix', 'СБ Нетфликс', 'SBN'], metadata: { client: 'Tilting Point', platform: 'Netflix Games', description: 'SpongeBob premium edition for Netflix Games, published by Tilting Point' } },
  { type: 'project', name: 'Oregon Trail', company: 'ac', aliases: ['Oregon Trail The Boomtown', 'Орегон Трейл', 'OT', 'TOT', 'The Oregon Trail'], metadata: { client: 'Tilting Point' } },
  { type: 'project', name: 'Aquarium', company: 'ac', aliases: ['Аквариум', 'Дрифт'] },
  { type: 'project', name: 'Idle Axe Thrower', company: 'ac', aliases: ['IAT', 'Magic Archery', 'Viking', 'топоры'] },
  { type: 'project', name: 'Motor World: Car Factory', company: 'ac', aliases: ['MWCF', 'Motor World Car Factory', 'Ohbibi MWCF', 'ohbibi-mwcf', 'MotorW', 'OhBibi Creatives', 'ohbibi-mwcf-creatives', 'MWCF Creatives'], metadata: { client: 'Ohbibi', description: 'Production + креативы (UA) для MWCF' } },
  { type: 'project', name: 'Symphonia', company: 'ac', aliases: ['Симфония'], metadata: { description: 'Издательская деятельность Astro Cat' } },
  { type: 'project', name: 'Tough Guy', company: 'ac', aliases: ['Таф Гай'], metadata: { description: 'Издательская деятельность Astro Cat' } },
  { type: 'project', name: 'Vector', company: 'ac', aliases: ['Вектор', 'VECTOR'] },
  { type: 'project', name: 'MOBA BACALHAU', company: 'ac', aliases: ['Моба', 'Бакаляо', 'MOBA', 'Bacalhau', 'Бакалау'] },
  // New projects from CSV seed
  { type: 'project', name: 'Block Puzzle', company: 'ac', aliases: ['BP', 'пазлы', 'Блок Пазл'] },
  { type: 'project', name: 'Clash of Gods', company: 'ac', aliases: ['CoG', 'Боу', 'Bow'] },
  { type: 'project', name: 'Pong Breaker Royale', company: 'ac', aliases: ['Pong', 'Понг'] },
  { type: 'project', name: 'Puppet Master', company: 'ac', aliases: ['Puppet', 'Паппет', 'Summoner'] },
  { type: 'project', name: 'LifeQuest', company: 'ac' },
  { type: 'project', name: 'DnD 3000', company: 'ac' },
  { type: 'project', name: 'Karl Storz', company: 'hg', metadata: { client: 'SNKE' }, aliases: ['Karl'] },
  { type: 'project', name: 'Botox', company: 'hg', aliases: ['Ботокс'], metadata: { client: 'Relevate Health' } },
]

// ── Processes ──

export const processes: SeedEntity[] = [
  { type: 'process', name: 'Character Art Brief', metadata: { project: 'Star Trek Timelines', description: 'Character art creation pipeline for STT' } },
  { type: 'process', name: 'Content Planning', metadata: { project: 'Star Trek Timelines', description: 'Content release planning for STT' } },
  { type: 'process', name: 'Buddy Check', metadata: { project: 'Star Trek Timelines', description: 'Peer review process for STT' } },
  { type: 'process', name: 'Live Operations Scheduling', aliases: ['LiveOps', 'Live Ops'], metadata: { project: 'Star Trek Timelines', description: 'Live event scheduling for STT' } },
]

// ── People ──

export const people: SeedEntity[] = [
  // Leadership
  { type: 'person', name: 'Дарий', company: 'ac', aliases: ['Dariy', 'dariy', 'Дарий Шацких', 'Dariy Shatskikh'], metadata: { role: 'CPO HG, VP Production AC', display_name: 'Дарий' } },
  { type: 'person', name: 'Арсен', company: 'hg', aliases: ['Arsen'], metadata: { role: 'CEO HG', display_name: 'Арсен' } },
  { type: 'person', name: 'Никита Кокарев', company: 'hg', aliases: ['Никита К.', 'Nikita K', 'Nikita Kokarev'], metadata: { role: 'Co-founder, Art Director', display_name: 'Никита К.' } },
  { type: 'person', name: 'Слава', company: 'hg', aliases: ['Вячеслав Куряков', 'Slava', 'Vyacheslav'], metadata: { role: 'Co-founder HG', display_name: 'Слава' } },
  { type: 'person', name: 'Йенг', company: 'ac', aliases: ['Yeng', 'Yang Wen'], metadata: { role: 'CEO AC', display_name: 'Йенг' } },
  { type: 'person', name: 'Брент', company: 'ac', aliases: ['Brent'], metadata: { role: 'Co-founder AC', display_name: 'Брент' } },

  // PMs (cross-project)
  { type: 'person', name: 'Анастасия Воронова', aliases: ['Настя', 'Anastasia', 'Nastya', 'Анастасия', 'Anastasia Voronova'], metadata: { role: 'PM', display_name: 'Настя (PM)' } },
  { type: 'person', name: 'Анастасия Емельяненко', aliases: ['Anastasia Emelyanenko'], metadata: { role: 'HR', display_name: 'Настя (HR)' } },
  { type: 'person', name: 'Александра', aliases: ['Саша', 'Alexandra', 'Sasha'], metadata: { role: 'PM', display_name: 'Саша' } },

  // Developers
  { type: 'person', name: 'Семён', company: 'hg', aliases: ['Semyon', 'Semen', 'Semён'], metadata: { role: 'Developer', display_name: 'Семён' } },
  { type: 'person', name: 'Рустам', company: 'ac', aliases: ['Rustam'], metadata: { role: 'Dev Lead (STT)', display_name: 'Рустам' } },
  { type: 'person', name: 'Валера', company: 'ac', aliases: ['Valera'], metadata: { role: 'Tech Expert (STT)', display_name: 'Валера' } },
  { type: 'person', name: 'Руслан', company: 'ac', aliases: ['Ruslan'], metadata: { role: 'Developer', display_name: 'Руслан' } },
  { type: 'person', name: 'Дмитрий', company: 'ac', aliases: ['Dmitry'], metadata: { role: 'Developer', display_name: 'Дмитрий' } },
  { type: 'person', name: 'Дияр', company: 'ac', aliases: ['Diyar'], metadata: { role: 'Developer', display_name: 'Дияр' } },
  { type: 'person', name: 'Никита Щукин', company: 'ac', aliases: ['Nikita Shchukin', 'Nikita Sch'], metadata: { role: 'Developer', display_name: 'Никита Щ.' } },
  { type: 'person', name: 'Алехандро', company: 'hg', aliases: ['Александр', 'Alejandro'], metadata: { role: 'Mini-TL', display_name: 'Алехандро' } },
  { type: 'person', name: 'Амгалан', aliases: ['Amgalan'], metadata: { role: 'Developer', display_name: 'Амгалан' } },
  { type: 'person', name: 'Игорь', aliases: ['Igor'], metadata: { role: 'Developer', display_name: 'Игорь' } },
  { type: 'person', name: 'Иван', aliases: ['Ivan'], metadata: { role: 'Developer', display_name: 'Иван' } },
  { type: 'person', name: 'Алмазхан', company: 'ac', aliases: ['Almazkhan'], metadata: { role: 'Developer', display_name: 'Алмазхан' } },
  { type: 'person', name: 'Всеволод', company: 'hg', aliases: ['Vsevolod'], metadata: { role: 'Developer (HTML5)', display_name: 'Всеволод' } },
  { type: 'person', name: 'Илья Воронов', company: 'ac', aliases: ['Ilya Voronov'], metadata: { role: 'Developer (STT)', display_name: 'Илья В.' } },

  // Game Design
  { type: 'person', name: 'Сергей Клепицкий', company: 'ac', aliases: ['Sergey Klepitsky'], metadata: { role: 'Game Designer', display_name: 'Сергей (ГД)' } },
  { type: 'person', name: 'Фарид', company: 'hg', aliases: ['Farid'], metadata: { role: 'Game Designer', display_name: 'Фарид' } },
  { type: 'person', name: 'Илья Бочаров', company: 'ac', aliases: ['Ilya Bocharov'], metadata: { role: 'Game Designer (STT)', display_name: 'Илья Б.' } },
  { type: 'person', name: 'Анна Буткеева', company: 'ac', aliases: ['Anna Butkeeva'], metadata: { role: 'Game Designer (STT)', display_name: 'Анна' } },
  { type: 'person', name: 'Ян Ромарчук', company: 'ac', aliases: ['Yan', 'Jan'], metadata: { role: 'Game Designer', display_name: 'Ян' } },

  // Art
  { type: 'person', name: 'Катя Дочкина', aliases: ['Катя', 'Ekaterina', 'Katya'], metadata: { role: 'UI/UX Designer', display_name: 'Катя' } },
  { type: 'person', name: 'Марина Назарова', aliases: ['Marina Nazarova'], metadata: { role: 'Artist', display_name: 'Марина Н.' } },
  { type: 'person', name: 'Наиля', aliases: ['Nailya'], metadata: { role: 'Artist', display_name: 'Наиля' } },
  { type: 'person', name: 'Денис', aliases: ['Denis'], metadata: { role: 'VFX Artist', display_name: 'Денис' } },
  { type: 'person', name: 'Александр Прудко', aliases: ['Prudko'], metadata: { role: 'VFX Artist', display_name: 'Прудко' } },
  { type: 'person', name: 'Марина Ляндина', company: 'hg', aliases: ['Marina Lyandina'], metadata: { role: 'Artist (HTML5)', display_name: 'Марина Л.' } },

  // QA
  { type: 'person', name: 'Данил', aliases: ['Danil'], metadata: { role: 'QA', display_name: 'Данил' } },
  { type: 'person', name: 'Сергей Гуменюк', aliases: ['Sergey', 'Sergey Gumenyuk', 'Сергей'], metadata: { role: 'QA Lead', display_name: 'Сергей (QA)' } },
  { type: 'person', name: 'Алёна Субботина', company: 'hg', aliases: ['Alyona', 'Алёна'], metadata: { role: 'Support (Level One)', display_name: 'Алёна' } },

  // Analytics & Marketing
  { type: 'person', name: 'Юлия Дюфлот', company: 'ac', aliases: ['Julia', 'Yulia', 'Юлия', 'Yulia Dyuflot'], metadata: { role: 'Analytics', display_name: 'Юля (аналитик)' } },
  { type: 'person', name: 'Юлия Чатялян', aliases: ['Yulia Chatyalyan'], metadata: { role: 'Marketing', display_name: 'Юля (маркетинг)' } },
  { type: 'person', name: 'Юлия Гречаная', aliases: ['Yulia Grechanaya'], metadata: { role: 'Org', display_name: 'Юля (орг)' } },
  { type: 'person', name: 'Богдан', company: 'ac', aliases: ['Bogdan'], metadata: { role: 'UA', display_name: 'Богдан' } },
  { type: 'person', name: 'Челси', company: 'ac', aliases: ['Chelsea'], metadata: { role: 'Marketing', display_name: 'Челси' } },
]

// ── Relations ──

export const relations: SeedRelation[] = [
  // Company membership
  { from: 'Дарий', to: 'Highground', relation: 'member_of', role: 'CPO' },
  { from: 'Дарий', to: 'AstroCat', relation: 'member_of', role: 'VP Production, Co-founder' },
  { from: 'Арсен', to: 'Highground', relation: 'owns', role: 'CEO' },
  { from: 'Арсен', to: 'AstroCat', relation: 'member_of', role: 'Board' },
  { from: 'Никита Кокарев', to: 'Highground', relation: 'owns', role: 'Co-founder, Art Director' },
  { from: 'Слава', to: 'Highground', relation: 'owns', role: 'Co-founder' },
  { from: 'Йенг', to: 'AstroCat', relation: 'owns', role: 'CEO' },
  { from: 'Брент', to: 'AstroCat', relation: 'owns', role: 'Co-founder' },

  // Level One
  { from: 'Дарий', to: 'Level One', relation: 'manages', role: 'PM' },
  { from: 'Семён', to: 'Level One', relation: 'works_on', role: 'Lead Developer' },
  { from: 'Фарид', to: 'Level One', relation: 'works_on', role: 'Game Designer' },
  { from: 'Данил', to: 'Level One', relation: 'works_on', role: 'QA' },
  { from: 'Алёна Субботина', to: 'Level One', relation: 'works_on', role: 'Support' },
  { from: 'Катя Дочкина', to: 'Level One', relation: 'works_on', role: 'UI/UX' },

  // Level Two
  { from: 'Александра', to: 'Level Two', relation: 'manages', role: 'PM' },
  { from: 'Алехандро', to: 'Level Two', relation: 'works_on', role: 'Mini-TL' },
  { from: 'Амгалан', to: 'Level Two', relation: 'works_on', role: 'Developer' },
  { from: 'Игорь', to: 'Level Two', relation: 'works_on', role: 'Developer' },
  { from: 'Сергей Гуменюк', to: 'Level Two', relation: 'works_on', role: 'QA Lead' },
  { from: 'Данил', to: 'Level Two', relation: 'works_on', role: 'QA' },

  // Pivot Pumps
  { from: 'Слава', to: 'Pivot Pumps', relation: 'manages', role: 'PM' },
  { from: 'Алехандро', to: 'Pivot Pumps', relation: 'works_on', role: 'Developer' },
  { from: 'Амгалан', to: 'Pivot Pumps', relation: 'works_on', role: 'Developer' },
  { from: 'Игорь', to: 'Pivot Pumps', relation: 'works_on', role: 'Developer' },
  { from: 'Сергей Гуменюк', to: 'Pivot Pumps', relation: 'works_on', role: 'QA' },

  // HTML5 Banners
  { from: 'Александра', to: 'HTML5 Banners', relation: 'manages', role: 'PM' },
  { from: 'Всеволод', to: 'HTML5 Banners', relation: 'works_on', role: 'Developer' },
  { from: 'Марина Ляндина', to: 'HTML5 Banners', relation: 'works_on', role: 'Artist' },

  // Playable Ads
  { from: 'Алехандро', to: 'Playable Ads', relation: 'works_on', role: 'Developer' },

  // Star Trek Timelines
  { from: 'Анастасия Воронова', to: 'Star Trek Timelines', relation: 'manages', role: 'PM' },
  { from: 'Рустам', to: 'Star Trek Timelines', relation: 'works_on', role: 'Dev Lead' },
  { from: 'Валера', to: 'Star Trek Timelines', relation: 'works_on', role: 'Tech Expert' },
  { from: 'Илья Воронов', to: 'Star Trek Timelines', relation: 'works_on', role: 'Developer' },
  { from: 'Илья Бочаров', to: 'Star Trek Timelines', relation: 'works_on', role: 'Game Designer' },
  { from: 'Анна Буткеева', to: 'Star Trek Timelines', relation: 'works_on', role: 'Game Designer' },
  { from: 'Tilting Point', to: 'Star Trek Timelines', relation: 'client_of' },

  // SpongeBob: Krusty Cook-Off (F2P / LiveOps)
  { from: 'Анастасия Воронова', to: 'SpongeBob: Krusty Cook-Off', relation: 'manages', role: 'PM' },
  { from: 'Руслан', to: 'SpongeBob: Krusty Cook-Off', relation: 'works_on', role: 'Developer' },
  { from: 'Дмитрий', to: 'SpongeBob: Krusty Cook-Off', relation: 'works_on', role: 'Developer' },
  { from: 'Дияр', to: 'SpongeBob: Krusty Cook-Off', relation: 'works_on', role: 'Developer' },
  { from: 'Никита Щукин', to: 'SpongeBob: Krusty Cook-Off', relation: 'works_on', role: 'Developer' },
  { from: 'Юлия Дюфлот', to: 'SpongeBob: Krusty Cook-Off', relation: 'works_on', role: 'Analytics' },
  { from: 'Tilting Point', to: 'SpongeBob: Krusty Cook-Off', relation: 'client_of' },

  // SpongeBob Get Cookin' (Netflix Games)
  { from: 'Анастасия Воронова', to: "SpongeBob Get Cookin'", relation: 'manages', role: 'PM' },
  { from: 'Руслан', to: "SpongeBob Get Cookin'", relation: 'works_on', role: 'Developer' },

  // Oregon Trail
  { from: 'Иван', to: 'Oregon Trail', relation: 'works_on', role: 'Developer' },
  { from: 'Ян Ромарчук', to: 'Oregon Trail', relation: 'works_on', role: 'Game Designer' },

  // Aquarium
  { from: 'Александра', to: 'Aquarium', relation: 'manages', role: 'PM' },
  { from: 'Семён', to: 'Aquarium', relation: 'works_on', role: 'Developer' },
  { from: 'Амгалан', to: 'Aquarium', relation: 'works_on', role: 'Developer' },
  { from: 'Алмазхан', to: 'Aquarium', relation: 'works_on', role: 'Developer' },
  { from: 'Сергей Гуменюк', to: 'Aquarium', relation: 'works_on', role: 'QA' },
  { from: 'Юлия Дюфлот', to: 'Aquarium', relation: 'works_on', role: 'Analytics' },

  // Idle Axe Thrower
  { from: 'Игорь', to: 'Idle Axe Thrower', relation: 'works_on', role: 'Developer' },
  { from: 'Ян Ромарчук', to: 'Idle Axe Thrower', relation: 'works_on', role: 'Game Designer' },
  { from: 'Марина Назарова', to: 'Idle Axe Thrower', relation: 'works_on', role: 'Artist' },
  { from: 'Сергей Гуменюк', to: 'Idle Axe Thrower', relation: 'works_on', role: 'QA' },

  // Motor World: Car Factory (Production)
  { from: 'Дарий', to: 'Motor World: Car Factory', relation: 'manages', role: 'PM' },
  { from: 'Семён', to: 'Motor World: Car Factory', relation: 'works_on', role: 'Developer' },
  { from: 'Алмазхан', to: 'Motor World: Car Factory', relation: 'works_on', role: 'Developer' },
  { from: 'Данил', to: 'Motor World: Car Factory', relation: 'works_on', role: 'QA' },
  { from: 'Сергей Гуменюк', to: 'Motor World: Car Factory', relation: 'works_on', role: 'QA' },
  { from: 'Ohbibi', to: 'Motor World: Car Factory', relation: 'client_of' },

  // Motor World: Car Factory — Creatives / UA (merged from OhBibi Creatives)
  { from: 'Анастасия Воронова', to: 'Motor World: Car Factory', relation: 'works_on', role: 'Creative Producer' },
  { from: 'Богдан', to: 'Motor World: Car Factory', relation: 'works_on', role: 'UA' },

  // Tough Guy
  { from: 'Иван', to: 'Tough Guy', relation: 'owns', role: 'Creator' },
  { from: 'Данил', to: 'Tough Guy', relation: 'works_on', role: 'QA' },
  { from: 'Сергей Гуменюк', to: 'Tough Guy', relation: 'works_on', role: 'QA' },
  { from: 'Богдан', to: 'Tough Guy', relation: 'works_on', role: 'UA' },
  { from: 'Челси', to: 'Tough Guy', relation: 'works_on', role: 'Marketing' },

  // Client relationships
  { from: 'Relevate Health', to: 'Level One', relation: 'client_of' },
  { from: 'Relevate Health', to: 'Level Two', relation: 'client_of' },
  { from: 'Relevate Health', to: 'HTML5 Banners', relation: 'client_of' },
  { from: 'Relevate Health', to: 'Playable Ads', relation: 'client_of' },

  // Vector
  { from: 'Сергей Клепицкий', to: 'Vector', relation: 'works_on', role: 'Game Designer' },

  // MOBA BACALHAU
  { from: 'Сергей Клепицкий', to: 'MOBA BACALHAU', relation: 'works_on', role: 'Game Designer' },

  // Additional client relationships (from CSV)
  { from: 'Tilting Point', to: 'Oregon Trail', relation: 'client_of' },
  { from: 'Relevate Health', to: 'Pivot Pumps', relation: 'client_of' },
  { from: 'Relevate Health', to: 'Botox', relation: 'client_of' },
  { from: 'SNKE', to: 'Karl Storz', relation: 'client_of' },
  { from: 'Tilting Point', to: "SpongeBob Get Cookin'", relation: 'client_of' },

  // Process → Project relationships
  { from: 'Character Art Brief', to: 'Star Trek Timelines', relation: 'member_of' },
  { from: 'Content Planning', to: 'Star Trek Timelines', relation: 'member_of' },
  { from: 'Buddy Check', to: 'Star Trek Timelines', relation: 'member_of' },
  { from: 'Live Operations Scheduling', to: 'Star Trek Timelines', relation: 'member_of' },
]

export const allEntities: SeedEntity[] = [...companies, ...projects, ...processes, ...people]

// ── Main (legacy PG seed) ──

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  console.log('Seeding KB entity graph from Master Document v2...\n')

  let entitiesCreated = 0
  let aliasesCreated = 0
  let relationsCreated = 0

  // Seed all entities
  for (const entity of allEntities) {
    const id = await createEntity(db, {
      type: entity.type,
      name: entity.name,
      company: entity.company,
      metadata: { ...entity.metadata, source: 'seed' },
    })
    entitiesCreated++

    for (const alias of entity.aliases ?? []) {
      try {
        await addAlias(db, id, alias)
        aliasesCreated++
      } catch {
        // Alias already exists — skip
      }
    }
  }

  console.log(`  Entities: ${entitiesCreated}`)
  console.log(`  Aliases:  ${aliasesCreated}`)

  // Seed relations
  for (const rel of relations) {
    try {
      const fromEntity = await findEntityByName(db, rel.from)
      const toEntity = await findEntityByName(db, rel.to)
      if (!fromEntity || !toEntity) {
        console.log(`  WARN: relation ${rel.from} → ${rel.to} skipped (entity not found)`)
        continue
      }
      await addRelation(db, {
        fromId: fromEntity.id,
        toId: toEntity.id,
        relation: rel.relation,
        role: rel.role,
        metadata: { source: 'seed' },
      })
      relationsCreated++
    } catch (error) {
      console.log(`  WARN: relation ${rel.from} → ${rel.to}: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.log(`  Relations: ${relationsCreated}`)
  console.log('\nSeed complete.')

  await pool.end()
}

// Need to import findEntityByName for resolving relation endpoints
import { findEntityByName } from './repository.js'

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
