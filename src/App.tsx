/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Users, UserPlus, RefreshCw, Home, Plus, FileUp, Calendar, Phone, 
  CheckCircle2, Clock, ChevronRight, Trash2, X, LogOut, ShieldCheck, 
  Building2, AlertCircle, UserCheck, Edit2, LayoutGrid, Route, Percent, Dumbbell, Wind, Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import { GoogleGenAI } from "@google/genai";
import { format, isToday, isAfter, parseISO, startOfDay } from 'date-fns';
import { cn } from './lib/utils';
import { 
  auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, 
  doc, getDoc, setDoc, updateDoc, collection, query, where, onSnapshot, 
  deleteDoc, getDocs 
} from './firebase';
import {
  NewConsultation,
  RenewalTarget,
  RenewalRegistrationStatus,
  UserProfile,
  BranchType,
  UserRole,
  RemindInfo,
} from './types';

const RENEWAL_REGISTRATION_OPTIONS: RenewalRegistrationStatus[] = ['재등록', '재등록 예정', '미재등록', '재등록거부'];

const BRANCHES: BranchType[] = ['본사', '쌍문점', '외대점', '길동점', '시청점', '시청역점', '광화문점', '노원점'];
const DISPLAY_BRANCHES = BRANCHES.filter(b => b !== '본사');
const POSITIONS = ['이사진', '지점장', 'FC', '팀장', '코치'];
const CATEGORIES = ['헬스권', 'PT', '스피닝', '요가', '골프'];
const VISIT_PATHS = ['워크인', '지인소개', '전화', '네이버예약', '네이버검색', '법인제휴', '인스타', '네이버톡톡', '리뷰노트', '당근', '기타'];

const AI_TONE_CHOICES: { value: string; label: string }[] = [
  { value: '상냥하게', label: '상냥하게' },
  { value: '긴급하게', label: '긴급하게' },
];
const AI_BENEFIT_CHOICES: { value: string; label: string }[] = [
  { value: '마감임박', label: '마감임박' },
  { value: '기한설정 혜택 적용', label: '기한설정 혜택' },
  { value: '15일전 재등록 시 10% 추가할인', label: '15일전 10% 할인' },
];
const AI_SCHEDULE_CHOICES: { value: string; label: string }[] = [
  { value: '오늘 상담 일정', label: '오늘 상담' },
  { value: '추후 상담 일정', label: '추후 상담' },
];

const GEMINI_MODEL_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'] as const;

function extractGeneratedText(response: {
  text?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  const fromGetter = typeof response.text === 'string' ? response.text.trim() : '';
  if (fromGetter) return fromGetter;
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts?.length) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

type CountBarItem = { label: string; count: number };

function buildCategoryCountBars(consultations: NewConsultation[]): CountBarItem[] {
  const map = new Map<string, number>();
  for (const c of consultations) {
    const cat = c.category?.trim() || '미지정';
    map.set(cat, (map.get(cat) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function buildVisitPathCountBars(consultations: NewConsultation[]): CountBarItem[] {
  const map = new Map<string, number>();
  for (const c of consultations) {
    const p = c.visitPath?.trim() || '미입력';
    map.set(p, (map.get(p) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

type RegistrationBreakdown = { label: string; count: number; registered: number; rate: number };

function buildRegistrationBreakdown(consultations: NewConsultation[]): RegistrationBreakdown[] {
  const map = new Map<string, { count: number; registered: number }>();
  for (const c of consultations) {
    const cat = c.category?.trim() || '미지정';
    const cur = map.get(cat) || { count: 0, registered: 0 };
    cur.count += 1;
    if (c.registrationStatus === '등록') cur.registered += 1;
    map.set(cat, cur);
  }
  return [...map.entries()]
    .map(([label, { count, registered }]) => ({
      label,
      count,
      registered,
      rate: count > 0 ? Math.round((registered / count) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function ConsultationMetricBar(props: {
  label: string;
  value: number;
  max: number;
  suffix: string;
  barClass: string;
  subLine?: string;
}) {
  const { label, value, max, suffix, barClass, subLine } = props;
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-700 truncate pr-1" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums font-bold text-slate-800">
          {value}
          {suffix}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden ring-1 ring-slate-200/60">
        <div className={cn('h-full rounded-full transition-all duration-500 ease-out', barClass)} style={{ width: `${pct}%` }} />
      </div>
      {subLine && <p className="text-[10px] text-slate-400 tabular-nums">{subLine}</p>}
    </div>
  );
}

function NewConsultationAnalyticsDashboard({
  consultations,
  monthLabel,
}: {
  consultations: NewConsultation[];
  monthLabel: string;
}) {
  const categoryBars = useMemo(() => buildCategoryCountBars(consultations), [consultations]);
  const visitPathBars = useMemo(() => buildVisitPathCountBars(consultations), [consultations]);
  const registrationRows = useMemo(() => buildRegistrationBreakdown(consultations), [consultations]);
  const overall = useMemo(() => {
    const total = consultations.length;
    const registered = consultations.filter((c) => c.registrationStatus === '등록').length;
    return { total, registered, rate: total > 0 ? Math.round((registered / total) * 100) : 0 };
  }, [consultations]);

  const maxCat = categoryBars[0]?.count ?? 1;
  const maxPath = visitPathBars[0]?.count ?? 1;

  if (consultations.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center text-sm text-slate-400">
        {monthLabel} · 표시할 신규 상담이 없습니다.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500 px-0.5">신규 상담 인사이트 · {monthLabel}</p>
      <div className="grid gap-5 lg:grid-cols-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col min-h-[320px]">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
              <LayoutGrid size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 leading-tight">종목별 상담 인원</h3>
              <p className="text-[11px] text-slate-500">종목당 상담 건수</p>
            </div>
          </div>
          <div className="mt-4 space-y-3 flex-1 overflow-y-auto max-h-[300px] pr-1">
            {categoryBars.map((row) => (
              <div key={row.label}>
                <ConsultationMetricBar
                  label={row.label}
                  value={row.count}
                  max={maxCat}
                  suffix="명"
                  barClass="bg-gradient-to-r from-violet-500 to-fuchsia-500"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col min-h-[320px]">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
              <Route size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 leading-tight">방문 경로별 인원</h3>
              <p className="text-[11px] text-slate-500">유입 경로당 상담 건수</p>
            </div>
          </div>
          <div className="mt-4 space-y-3 flex-1 overflow-y-auto max-h-[300px] pr-1">
            {visitPathBars.map((row) => (
              <div key={row.label}>
                <ConsultationMetricBar
                  label={row.label}
                  value={row.count}
                  max={maxPath}
                  suffix="명"
                  barClass="bg-gradient-to-r from-sky-500 to-cyan-500"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col min-h-[320px]">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <Percent size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 leading-tight">상담 등록율</h3>
              <p className="text-[11px] text-slate-500">등록 상태 기준 (등록 / 전체)</p>
            </div>
          </div>
          <div className="mt-3 rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-white to-teal-50 p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700/80">전체 등록율</p>
            <div className="mt-1 flex items-end justify-between gap-2">
              <span className="text-4xl font-black tabular-nums text-emerald-900">{overall.rate}%</span>
              <span className="text-xs font-semibold text-emerald-800 tabular-nums pb-1">
                {overall.registered} / {overall.total}명
              </span>
            </div>
            <div className="mt-3 h-3 rounded-full bg-white/90 overflow-hidden shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                style={{ width: `${overall.rate}%` }}
              />
            </div>
          </div>
          <p className="mt-4 text-[10px] font-bold uppercase tracking-wide text-slate-500">종목별 등록율</p>
          <div className="mt-2 space-y-3 flex-1 overflow-y-auto max-h-[200px] pr-1">
            {registrationRows.map((row) => (
              <div key={row.label}>
                <ConsultationMetricBar
                  label={row.label}
                  value={row.rate}
                  max={100}
                  suffix="%"
                  barClass={
                    row.rate >= 50
                      ? 'bg-gradient-to-r from-emerald-500 to-green-500'
                      : row.rate > 0
                        ? 'bg-gradient-to-r from-amber-400 to-orange-400'
                        : 'bg-slate-300'
                  }
                  subLine={`등록 ${row.registered}명 / 전체 ${row.count}명`}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function normalizeRenewalTarget(docId: string, raw: Record<string, unknown>): RenewalTarget {
  const d = raw as Partial<RenewalTarget>;
  const st = d.renewalRegistrationStatus;
  const status: RenewalRegistrationStatus =
    st === '재등록' || st === '재등록 예정' || st === '미재등록' || st === '재등록거부' ? st : '미재등록';
  return {
    ...(d as RenewalTarget),
    id: docId,
    renewalCategory: (d.renewalCategory && String(d.renewalCategory).trim()) || '헬스권',
    renewalRegistrationStatus: status,
  };
}

function RenewalAnalyticsDashboard({ targets, monthLabel }: { targets: RenewalTarget[]; monthLabel: string }) {
  const healthList = useMemo(() => targets.filter((t) => t.renewalCategory === '헬스권'), [targets]);
  const spinList = useMemo(() => targets.filter((t) => t.renewalCategory === '스피닝'), [targets]);

  const renewedOf = (list: RenewalTarget[]) => list.filter((t) => t.renewalRegistrationStatus === '재등록').length;
  const rateOf = (list: RenewalTarget[]) =>
    list.length === 0 ? 0 : Math.round((renewedOf(list) / list.length) * 100);

  const overallRate = rateOf(targets);
  const healthRate = rateOf(healthList);
  const spinRate = rateOf(spinList);

  if (targets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center text-sm text-slate-400">
        {monthLabel} · 표시할 재등록 대상이 없습니다.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold text-slate-500 px-0.5">재등록 인사이트 · {monthLabel}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">총 재등록 대상</p>
          <p className="mt-2 text-3xl font-black tabular-nums text-slate-900">{targets.length}명</p>
          <p className="mt-2 text-[11px] text-slate-500">선택 월·지점 기준 목록</p>
        </div>
        <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-white p-5 shadow-sm">
          <div className="flex items-center gap-2 text-violet-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100">
              <Dumbbell size={16} />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wide">헬스 재등록 대상</p>
          </div>
          <p className="mt-2 text-3xl font-black tabular-nums text-violet-950">{healthList.length}명</p>
          <p className="mt-1 text-[11px] text-violet-700/80">종목 「헬스권」</p>
        </div>
        <div className="rounded-2xl border border-cyan-200 bg-gradient-to-br from-cyan-50 via-white to-white p-5 shadow-sm">
          <div className="flex items-center gap-2 text-cyan-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100">
              <Wind size={16} />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wide">스피닝 재등록 대상</p>
          </div>
          <p className="mt-2 text-3xl font-black tabular-nums text-cyan-950">{spinList.length}명</p>
          <p className="mt-1 text-[11px] text-cyan-700/80">종목 「스피닝」</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 p-5 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">전체 재등록율</p>
          <p className="mt-1 text-3xl font-black tabular-nums text-emerald-950">{overallRate}%</p>
          <p className="mt-1 text-xs font-semibold tabular-nums text-emerald-900">
            재등록 {renewedOf(targets)} / {targets.length}명
          </p>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/90 shadow-inner">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
              style={{ width: `${overallRate}%` }}
            />
          </div>
        </div>
      </div>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h4 className="text-sm font-bold text-slate-800">재등록율 보드</h4>
        <p className="mt-0.5 text-[11px] text-slate-500">상태가 「재등록」인 인원 ÷ 해당 그룹 전체 (막대 그래프)</p>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase text-slate-500">전체</p>
            <ConsultationMetricBar
              label="전체 대상"
              value={overallRate}
              max={100}
              suffix="%"
              barClass="bg-gradient-to-r from-emerald-500 to-teal-500"
              subLine={`재등록 ${renewedOf(targets)}명 / ${targets.length}명`}
            />
          </div>
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase text-violet-600">헬스권</p>
            <ConsultationMetricBar
              label="헬스권"
              value={healthRate}
              max={100}
              suffix="%"
              barClass="bg-gradient-to-r from-violet-500 to-fuchsia-500"
              subLine={`재등록 ${renewedOf(healthList)}명 / ${healthList.length}명`}
            />
          </div>
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase text-cyan-600">스피닝</p>
            <ConsultationMetricBar
              label="스피닝"
              value={spinRate}
              max={100}
              suffix="%"
              barClass="bg-gradient-to-r from-cyan-500 to-sky-500"
              subLine={`재등록 ${renewedOf(spinList)}명 / ${spinList.length}명`}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function SyncedHorizontalScrollbar({
  targetRef,
  className = '',
  sticky = false,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
  sticky?: boolean;
}) {
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [clientWidth, setClientWidth] = useState(0);
  const [isTargetVisible, setIsTargetVisible] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const update = () => {
      setScrollWidth(target.scrollWidth);
      setClientWidth(target.clientWidth);
      setScrollLeft(target.scrollLeft);
    };

    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(target);
    if (target.firstElementChild instanceof HTMLElement) ro.observe(target.firstElementChild);

    const io = new IntersectionObserver(
      (entries) => {
        setIsTargetVisible(entries.some((e) => e.isIntersecting));
      },
      { root: null, threshold: 0.01 }
    );
    io.observe(target);

    let syncing = false;
    const onTargetScroll = () => {
      if (syncing) return;
      syncing = true;
      setScrollLeft(target.scrollLeft);
      syncing = false;
    };

    target.addEventListener('scroll', onTargetScroll, { passive: true });

    return () => {
      ro.disconnect();
      io.disconnect();
      target.removeEventListener('scroll', onTargetScroll);
    };
  }, [targetRef]);

  useEffect(() => {
    if (!trackEl) return;
    const updateTrack = () => setTrackWidth(trackEl.clientWidth);
    updateTrack();
    const ro = new ResizeObserver(() => updateTrack());
    ro.observe(trackEl);
    return () => ro.disconnect();
  }, [trackEl]);

  if (!isTargetVisible) return null;
  if (!scrollWidth || scrollWidth <= clientWidth + 2) return null;

  const maxScroll = Math.max(1, scrollWidth - clientWidth);
  const maxThumbLeft = Math.max(0, trackWidth - Math.max(16, Math.round((clientWidth / scrollWidth) * trackWidth)));
  const thumbWidth = Math.max(16, Math.round((clientWidth / scrollWidth) * trackWidth));
  const thumbLeft = maxThumbLeft <= 0 ? 0 : Math.round((scrollLeft / maxScroll) * maxThumbLeft);

  const scrollToRatio = (ratio: number) => {
    const target = targetRef.current;
    if (!target) return;
    const next = Math.round(Math.min(1, Math.max(0, ratio)) * maxScroll);
    target.scrollLeft = next;
  };

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (e.button !== 0) return;
    const track = trackEl;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tw = track.clientWidth || trackWidth || 1;
    const ratio = (x - thumbWidth / 2) / Math.max(1, tw - thumbWidth);
    scrollToRatio(ratio);

    const currentScroll = targetRef.current?.scrollLeft ?? scrollLeft;
    const startLeftNow = maxThumbLeft <= 0 ? 0 : Math.round((currentScroll / maxScroll) * maxThumbLeft);
    dragStateRef.current = { pointerId: e.pointerId, startX: e.clientX, startLeft: startLeftNow };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const nextLeft = Math.min(maxThumbLeft, Math.max(0, s.startLeft + dx));
    const ratio = maxThumbLeft <= 0 ? 0 : nextLeft / maxThumbLeft;
    scrollToRatio(ratio);
  };

  const onPointerUpOrCancel: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
  };

  return (
    <div
      className={cn(
        'w-full',
        sticky && 'sticky top-2 z-[70] rounded-xl bg-white/80 backdrop-blur px-3 py-2 shadow-sm ring-1 ring-slate-200/60',
        className
      )}
    >
      <div
        ref={setTrackEl}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUpOrCancel}
        onPointerCancel={onPointerUpOrCancel}
        className="relative h-6 w-full rounded-md bg-slate-100/70 ring-1 ring-slate-200 select-none touch-none"
        aria-label="가로 스크롤"
        role="scrollbar"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={maxScroll}
        aria-valuenow={scrollLeft}
      >
        <div
          className="absolute top-1 bottom-1 rounded bg-slate-400/70 hover:bg-slate-500/70"
          style={{ width: thumbWidth, left: thumbLeft }}
        />
      </div>
    </div>
  );
}

const formatPhoneNumber = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
};

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'home' | 'new' | 'renewal' | 'admin'>('home');
  const [newConsultations, setNewConsultations] = useState<NewConsultation[]>([]);
  const [renewalTargets, setRenewalTargets] = useState<RenewalTarget[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [branchUsers, setBranchUsers] = useState<UserProfile[]>([]);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<BranchType | '전체'>('전체');
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [onboardingPhone, setOnboardingPhone] = useState('');
  const [consultationPhone, setConsultationPhone] = useState('');
  const [editingConsultation, setEditingConsultation] = useState<NewConsultation | null>(null);
  const [editingRemind, setEditingRemind] = useState<{ id: string, type: 'new' | 'renewal', remindIdx: number } | null>(null);
  const [editingRenewalTarget, setEditingRenewalTarget] = useState<RenewalTarget | null>(null);
  const [isCreatingRenewalTarget, setIsCreatingRenewalTarget] = useState(false);
  const [selectedRenewalIds, setSelectedRenewalIds] = useState<string[]>([]);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean, title: string, message: string, onConfirm: () => void } | null>(null);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [visitType, setVisitType] = useState<'당일' | '예약'>('당일');
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);
  const [aiOptions, setAiOptions] = useState({
    tone: '상냥하게',
    benefit: '마감임박',
    schedule: '오늘 상담 일정',
    additionalInfo: ''
  });
  const [remindModalContent, setRemindModalContent] = useState('');
  const [newListSearch, setNewListSearch] = useState('');
  const [newListRegFilter, setNewListRegFilter] = useState<'전체' | NewConsultation['registrationStatus']>('전체');
  const [newListCategoryFilter, setNewListCategoryFilter] = useState<'전체' | string>('전체');
  const [newListVisitPathFilter, setNewListVisitPathFilter] = useState<'전체' | string>('전체');
  const [newListSortKey, setNewListSortKey] = useState<'createdAt' | 'visitDate' | 'scheduledDate' | 'name'>('createdAt');
  const [newListSortDir, setNewListSortDir] = useState<'desc' | 'asc'>('desc');

  const [renewalListSearch, setRenewalListSearch] = useState('');
  const [renewalListStatusFilter, setRenewalListStatusFilter] = useState<'전체' | RenewalRegistrationStatus>('전체');
  const [renewalListCategoryFilter, setRenewalListCategoryFilter] = useState<'전체' | string>('전체');
  const [renewalListSortKey, setRenewalListSortKey] = useState<'no' | 'expiryDate' | 'name'>('no');
  const [renewalListSortDir, setRenewalListSortDir] = useState<'asc' | 'desc'>('asc');

  const newTableScrollRef = useRef<HTMLDivElement | null>(null);
  const renewalTableScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editingRemind) setRemindModalContent('');
  }, [editingRemind]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const copyRemindContentToClipboard = async () => {
    const text = remindModalContent.trim();
    if (!text) {
      showToast('복사할 내용이 없습니다.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('클립보드에 복사했습니다.');
    } catch {
      showToast('복사에 실패했습니다. 브라우저에서 클립보드 권한을 허용해 주세요.', 'error');
    }
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setConfirmModal({ isOpen: true, title, message, onConfirm });
  };

  const canDeleteRecords = user?.role === 'admin';
  const canDeleteRenewalTargets = !!user?.isApproved;

  const openCreateRenewalTarget = () => {
    if (!user) return;
    let targetBranch = user.branch;
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체') {
      targetBranch = selectedBranch as BranchType;
    }
    if (targetBranch === '본사') {
      showToast('본사는 지점이 아니므로 재등록 대상을 추가할 수 없습니다. 상단에서 지점을 선택해주세요.', 'error');
      return;
    }
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch === '전체') {
      showToast('상단에서 지점을 선택한 뒤 추가해주세요.', 'error');
      return;
    }

    const nextNo =
      renewalTargets.length > 0 ? Math.max(...renewalTargets.map((t) => t.no || 0)) + 1 : 1;
    setIsCreatingRenewalTarget(true);
    setEditingRenewalTarget({
      id: crypto.randomUUID(),
      branch: targetBranch,
      no: nextNo,
      name: '',
      gender: '여',
      age: 0,
      phone: '',
      membership: '',
      renewalCategory: '헬스권',
      renewalRegistrationStatus: '미재등록',
      locker: '',
      expiryDate: '',
      lastAttendance: '',
      remind1: { type: '', content: '', completed: false },
      remind2: { type: '', content: '', completed: false },
      remind3: { type: '', content: '', completed: false },
      uploadMonth: selectedMonth,
      uploadedBy: user.uid,
    });
  };

  const handleGenerateAI = async () => {
    if (!user || !editingRemind) return;
    const apiKey = process.env.GEMINI_API_KEY?.trim?.() ?? '';
    if (!apiKey) {
      showToast(
        'Gemini API 키가 없습니다. PC에 프로젝트 폴더에 .env 파일을 만들고 GEMINI_API_KEY=발급키 를 넣은 뒤 npm run build·배포하세요. GitHub 배포는 Actions 시크릿 GEMINI_API_KEY가 필요합니다.',
        'error'
      );
      return;
    }
    setIsGeneratingAI(true);
    try {
      const target = editingRemind.type === 'new' 
        ? newConsultations.find(c => c.id === editingRemind.id)
        : renewalTargets.find(t => t.id === editingRemind.id);
      
      const customerName = target?.name || '고객';
      const branch = user.branch;
      const staffName = user.displayName;
      const position = user.position || '직원';
      const round = editingRemind.remindIdx + 1;

      let prompt = "";
      
      if (editingRemind.type === 'new') {
        prompt = `당신은 헬스장 '짐구공'의 상담 직원입니다. ${customerName}님께 보낼 '${round}차 상담 후 리마인드' 문자를 작성해주세요.
형식: [짐구공 ${branch}] 안녕하세요, 짐구공 ${branch} ${staffName} ${position}입니다.

상황:
- 현재 ${round}번째 연락입니다. (1차: 첫 감사 인사, 2차/3차: 조심스러운 재문의)
- 말투: ${aiOptions.tone}
- 혜택 안내: ${aiOptions.benefit}
- 상담 일정 안내: ${aiOptions.schedule}
${aiOptions.additionalInfo ? `- 추가 정보/혜택: ${aiOptions.additionalInfo}` : ''}

핵심 지시사항:
- 문자가 너무 길지 않게 핵심만 간결하게 작성하세요.
- ${round}차 연락임을 고려하여 고객이 불편하지 않게 정중하고 세심하게 작성하세요.
- 2차 이상일 경우 "바쁘신 와중에 다시 연락드려 죄송합니다" 등의 표현을 적절히 섞어주세요.

참고 문구 (이 느낌을 살리되 ${round}차에 맞게 변형):
"안녕하세요 짐구공 시청점입니다. 오늘 방문해주셔서 감사합니다 :) 상담 후에 혹시 더 궁금하신 점 있으실까요? 선택해주시면 다시 한 번 친절하게 안내 도와드리겠습니다 :) 감사합니다."

출력은 오직 문자 내용만 해주세요.`;
      } else {
        const renewalTarget = target as RenewalTarget;
        const expiryDate = renewalTarget?.expiryDate || '만료 예정일';
        const membership = renewalTarget?.membership || '이용권';
        
        prompt = `당신은 헬스장 '짐구공'의 상담 직원입니다. 기존 회원인 ${customerName}님께 보낼 '${round}차 재등록 안내' 문자를 작성해주세요.
형식: [짐구공 ${branch}] 안녕하세요, 짐구공 ${branch} ${staffName} ${position}입니다.

고객 정보:
- 이름: ${customerName}
- 현재 이용권: ${membership}
- 만료 예정일: ${expiryDate}
- 현재 ${round}번째 안내입니다.

조건:
- 말투: ${aiOptions.tone}
- 혜택 안내: ${aiOptions.benefit}
- 상담 일정 안내: ${aiOptions.schedule}
${aiOptions.additionalInfo ? `- 추가 정보/혜택: ${aiOptions.additionalInfo}` : ''}

핵심 지시사항:
- 문자가 너무 길지 않게 핵심만 간결하게 작성하세요.
- ${round}차 연락임을 고려하여 고객이 부담을 느끼지 않도록 정중하게 작성하세요.
- 2차/3차 연락일 경우 "종료일이 다가와 다시 한번 안내드립니다" 등의 자연스러운 재안내 문구를 사용하세요.

참고 문구 (이 느낌을 살리되 ${round}차에 맞게 변형):
"회원님! 안녕하세요^^ 짐구공 ${branch} 입니다 :) 회원님 종료예정이 ${expiryDate}까지셔서 안내연락드렸습니다^^ 할인가로 재등록 도와드리려 하는데 연락주시면 특별한 혜택을 드리려 합니다."

출력은 오직 문자 내용만 해주세요.`;
      }

      const ai = new GoogleGenAI({ apiKey });
      let generatedText = '';
      let lastError: unknown;
      for (const model of GEMINI_MODEL_FALLBACKS) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
          });
          generatedText = extractGeneratedText(response);
          if (generatedText) break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!generatedText && lastError) throw lastError;

      setRemindModalContent(generatedText);
      if (!generatedText) {
        showToast('응답이 비어 있습니다. 잠시 후 다시 시도하거나 API 할당량을 확인하세요.', 'error');
      } else {
        showToast('AI 문구가 생성되었습니다.');
      }
    } catch (error) {
      console.error('AI generation error:', error);
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : '';
      const short =
        msg.length > 120
          ? `${msg.slice(0, 120)}…`
          : msg || '알 수 없는 오류';
      showToast(`AI 생성 실패: ${short}`, 'error');
    } finally {
      setIsGeneratingAI(false);
    }
  };

  const isRegisteringRef = useRef(false);

  const years = useMemo(() => Array.from({ length: 5 }, (_, i) => (new Date().getFullYear() - 2 + i).toString()), []);
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => (i + 1).toString().padStart(2, '0')), []);

  const handleMonthChange = (year: string, month: string) => {
    setSelectedMonth(`${year}-${month}`);
  };

  const currentYear = selectedMonth.split('-')[0];
  const currentMonth = selectedMonth.split('-')[1];

  // Auth State
  useEffect(() => {
    const firestoreTimeoutMs = 25_000;
    const withFirestoreTimeout = <T,>(promise: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const t = window.setTimeout(() => {
          reject(
            new Error(
              `Firestore 응답이 ${firestoreTimeoutMs / 1000}초 안에 오지 않았습니다. 인터넷, VPN, 애드블록을 확인하고 Firestore 규칙·앱 재배포 여부를 확인하세요.`
            )
          );
        }, firestoreTimeoutMs);
        promise.then(
          (v) => {
            window.clearTimeout(t);
            resolve(v);
          },
          (e) => {
            window.clearTimeout(t);
            reject(e);
          }
        );
      });

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setLoading(true);
      }
      try {
        if (firebaseUser) {
          const userDoc = await withFirestoreTimeout(getDoc(doc(db, 'users', firebaseUser.uid)));
          if (userDoc.exists()) {
            let userData = userDoc.data() as UserProfile;
            // Force promote master admin if not already
            if (firebaseUser.email === 'kayjeon0715@gmail.com' && (userData.role !== 'admin' || !userData.isApproved)) {
              const updates = { role: 'admin' as UserRole, isApproved: true, position: '관리자', phoneNumber: '010-0000-0000' };
              await withFirestoreTimeout(updateDoc(doc(db, 'users', firebaseUser.uid), updates));
              userData = { ...userData, ...updates };
            }
            setUser(userData);
            setSelectedBranch(userData.branch === '본사' ? '전체' : userData.branch);
          } else {
            // New user registration defaults
            const isAdmin = firebaseUser.email === 'kayjeon0715@gmail.com';
            const newUser: UserProfile = {
              uid: firebaseUser.uid,
              email: firebaseUser.email || '',
              displayName: firebaseUser.displayName || '사용자',
              photoURL: firebaseUser.photoURL || '',
              role: isAdmin ? 'admin' : 'staff',
              branch: '본사',
              position: isAdmin ? '관리자' : '',
              phoneNumber: isAdmin ? '010-0000-0000' : '',
              isApproved: isAdmin,
              createdAt: new Date().toISOString()
            };
            await withFirestoreTimeout(setDoc(doc(db, 'users', firebaseUser.uid), newUser));
            setUser(newUser);
          }
        } else {
          setUser(null);
        }
      } catch (e: unknown) {
        console.error('Auth / Firestore profile error:', e);
        const err = e as { code?: string; message?: string };
        const msg =
          err.code === 'permission-denied'
            ? 'Firestore 접근이 거부되었습니다. 콘솔에서 DB를 만들고 보안 규칙을 배포했는지 확인하세요.'
            : (err.message || '사용자 정보를 불러오지 못했습니다.');
        setToast({ message: msg, type: 'error' });
        setTimeout(() => setToast(null), 6000);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  // Data Fetching
  useEffect(() => {
    if (!user?.isApproved) return;

    let qConsultations = query(collection(db, 'consultations'));
    let qRenewals = query(collection(db, 'renewalTargets'));

    if (user.role === 'staff') {
      qConsultations = query(collection(db, 'consultations'), where('branch', '==', user.branch));
      qRenewals = query(collection(db, 'renewalTargets'), where('branch', '==', user.branch));
    } else if (selectedBranch !== '전체') {
      qConsultations = query(collection(db, 'consultations'), where('branch', '==', selectedBranch));
      qRenewals = query(collection(db, 'renewalTargets'), where('branch', '==', selectedBranch));
    }

    const unsubConsultations = onSnapshot(qConsultations, (snapshot) => {
      const allData = snapshot.docs.map(doc => doc.data() as NewConsultation);
      const filtered = allData.filter(c => {
        // Current month
        if (c.month === selectedMonth) return true;
        // Carry over: Previous months, not registered, 3rd remind not completed, and not manually completed
        if (
          c.month < selectedMonth &&
          c.registrationStatus !== '등록' &&
          c.registrationStatus !== '등록거부' &&
          !c.remind3?.completed &&
          !c.isCompleted
        )
          return true;
        return false;
      });
      setNewConsultations(filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
    });

    const unsubRenewals = onSnapshot(qRenewals, (snapshot) => {
      const allData = snapshot.docs.map((d) => normalizeRenewalTarget(d.id, d.data() as Record<string, unknown>));
      const filtered = allData.filter((t) => t.uploadMonth === selectedMonth);
      setRenewalTargets(filtered.sort((a, b) => (a.no || 0) - (b.no || 0)));
    });

    return () => {
      unsubConsultations();
      unsubRenewals();
    };
  }, [user, selectedBranch, selectedMonth]);

  // Admin: Fetch all users
  useEffect(() => {
    if (user?.role === 'admin' && activeTab === 'admin') {
      const unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        setAllUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
      });
      return unsubUsers;
    }
  }, [user, activeTab]);

  // Branch users: For consultant selection in new consultations
  useEffect(() => {
    if (!user?.isApproved) return;
    let targetBranch = user.branch;
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체') {
      targetBranch = selectedBranch as BranchType;
    }
    if (targetBranch === '본사' || selectedBranch === '전체') {
      setBranchUsers([]);
      return;
    }
    const q = query(collection(db, 'users'), where('branch', '==', targetBranch));
    const unsub = onSnapshot(q, (snapshot) => {
      const users = snapshot.docs.map((d) => d.data() as UserProfile);
      setBranchUsers(users.filter((u) => u.isApproved).sort((a, b) => a.displayName.localeCompare(b.displayName)));
    });
    return unsub;
  }, [user, selectedBranch]);

  // Clear selectedRenewalIds when filters change
  useEffect(() => {
    setSelectedRenewalIds([]);
  }, [selectedMonth, selectedBranch, activeTab]);

  const displayedNewConsultations = useMemo(() => {
    const q = newListSearch.trim().toLowerCase();
    const norm = (s: unknown) => String(s ?? '').toLowerCase();
    const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

    let list = newConsultations.slice();
    if (q) {
      const qDigits = q.replace(/\D/g, '');
      list = list.filter((c) => {
        const nameHit = norm(c.name).includes(q);
        const phoneHit = qDigits ? digits(c.contact).includes(qDigits) || digits(c.phone).includes(qDigits) : false;
        return nameHit || phoneHit;
      });
    }
    if (newListRegFilter !== '전체') list = list.filter((c) => (c.registrationStatus || '미등록') === newListRegFilter);
    if (newListCategoryFilter !== '전체') list = list.filter((c) => (c.category || '').trim() === newListCategoryFilter);
    if (newListVisitPathFilter !== '전체') list = list.filter((c) => (c.visitPath || '').trim() === newListVisitPathFilter);

    const key = newListSortKey;
    const dir = newListSortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name) * dir;
      const av = (a[key] || '') as string;
      const bv = (b[key] || '') as string;
      return av.localeCompare(bv) * dir;
    });
    return list;
  }, [
    newConsultations,
    newListSearch,
    newListRegFilter,
    newListCategoryFilter,
    newListVisitPathFilter,
    newListSortKey,
    newListSortDir,
  ]);

  const displayedRenewalTargets = useMemo(() => {
    const q = renewalListSearch.trim().toLowerCase();
    const norm = (s: unknown) => String(s ?? '').toLowerCase();
    const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

    let list = renewalTargets.slice();
    if (q) {
      const qDigits = q.replace(/\D/g, '');
      list = list.filter((t) => {
        const nameHit = norm(t.name).includes(q);
        const phoneHit = qDigits ? digits(t.phone).includes(qDigits) : false;
        return nameHit || phoneHit;
      });
    }
    if (renewalListStatusFilter !== '전체') list = list.filter((t) => t.renewalRegistrationStatus === renewalListStatusFilter);
    if (renewalListCategoryFilter !== '전체') list = list.filter((t) => (t.renewalCategory || '').trim() === renewalListCategoryFilter);

    const key = renewalListSortKey;
    const dir = renewalListSortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === 'no') return ((a.no || 0) - (b.no || 0)) * dir;
      if (key === 'name') return a.name.localeCompare(b.name) * dir;
      const av = (a[key] || '') as string;
      const bv = (b[key] || '') as string;
      return av.localeCompare(bv) * dir;
    });
    return list;
  }, [
    renewalTargets,
    renewalListSearch,
    renewalListStatusFilter,
    renewalListCategoryFilter,
    renewalListSortKey,
    renewalListSortDir,
  ]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const code = err.code ?? '';
      if (code === 'auth/popup-blocked') {
        showToast('팝업이 차단되었습니다. 주소창 옆에서 팝업을 허용해 주세요.', 'error');
      } else if (code === 'auth/unauthorized-domain') {
        showToast('이 주소가 Firebase 승인 도메인에 없습니다. 콘솔에서 도메인을 추가해 주세요.', 'error');
      } else if (code === 'auth/operation-not-allowed') {
        showToast('Google 로그인이 꺼져 있습니다. Firebase 콘솔에서 로그인 방법을 켜 주세요.', 'error');
      } else {
        showToast(err.message || '로그인에 실패했습니다.', 'error');
      }
    }
  };
  const handleLogout = () => signOut(auth);

  const handleRegisterStaff = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    try {
      const formData = new FormData(e.currentTarget);
      const updates = {
        displayName: String(formData.get('name') || '').trim(),
        phoneNumber: String(formData.get('phone') || '').trim(),
        position: String(formData.get('position') || '').trim(),
        branch: formData.get('branch') as BranchType,
      };
      await updateDoc(doc(db, 'users', user.uid), updates);
      setUser({ ...user, ...updates });
      showToast('등록이 완료되었습니다. 관리자 승인 후 이용 가능합니다.');
    } catch (error) {
      console.error('Staff registration error:', error);
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : '';
      showToast(msg ? `등록 실패: ${msg}` : '등록에 실패했습니다. 권한/네트워크를 확인해주세요.', 'error');
    }
  };

  const handleApproveUser = async (uid: string, isApproved: boolean) => {
    await updateDoc(doc(db, 'users', uid), { isApproved });
  };

  const handleUpdateUserRole = async (uid: string, role: UserRole, branch: BranchType) => {
    await updateDoc(doc(db, 'users', uid), { role, branch });
  };

  const handleDeleteSelectedRenewals = async () => {
    if (selectedRenewalIds.length === 0) return;
    if (!canDeleteRenewalTargets) {
      showToast('삭제 권한이 없습니다. 승인된 사용자만 삭제할 수 있습니다.', 'error');
      return;
    }
    showConfirm(
      '선택 삭제',
      `선택한 ${selectedRenewalIds.length}명의 데이터를 삭제하시겠습니까?`,
      async () => {
        try {
          for (const id of selectedRenewalIds) {
            await deleteDoc(doc(db, 'renewalTargets', id));
          }
          setSelectedRenewalIds([]);
          showToast('삭제되었습니다.');
        } catch (error) {
          console.error('Error deleting selected renewals:', error);
          const msg =
            error instanceof Error
              ? error.message
              : typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message: unknown }).message)
                : '';
          showToast(
            msg.includes('permission')
              ? '삭제 권한이 없습니다. (지점 권한/승인 상태를 확인해주세요)'
              : '삭제 중 오류가 발생했습니다.',
            'error'
          );
        }
      }
    );
  };

  const handleDeleteAllRenewals = async () => {
    if (renewalTargets.length === 0) return;
    if (!canDeleteRenewalTargets) {
      showToast('삭제 권한이 없습니다. 승인된 사용자만 삭제할 수 있습니다.', 'error');
      return;
    }
    showConfirm(
      '전체 삭제',
      '현재 목록의 모든 데이터를 삭제하시겠습니까?',
      async () => {
        try {
          for (const target of renewalTargets) {
            await deleteDoc(doc(db, 'renewalTargets', target.id));
          }
          setSelectedRenewalIds([]);
          showToast('모든 데이터가 삭제되었습니다.');
        } catch (error) {
          console.error('Error deleting all renewals:', error);
          const msg =
            error instanceof Error
              ? error.message
              : typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message: unknown }).message)
                : '';
          showToast(
            msg.includes('permission')
              ? '삭제 권한이 없습니다. (지점 권한/승인 상태를 확인해주세요)'
              : '삭제 중 오류가 발생했습니다.',
            'error'
          );
        }
      }
    );
  };

  const startEditing = (c: NewConsultation) => {
    setEditingConsultation(c);
    setConsultationPhone(c.contact);
    setVisitType(c.visitDate ? '당일' : '예약');
    setIsAddingNew(true);
    setActiveTab('new');
  };

  const cancelEditing = () => {
    setEditingConsultation(null);
    setConsultationPhone('');
    setVisitType('당일');
    setIsAddingNew(false);
  };

  const upcomingVisits = useMemo(() => {
    const today = startOfDay(new Date());
    return newConsultations
      .filter(c => !c.isCompleted && (c.scheduledDate || c.visitDate))
      .filter(c => {
        const dateStr = c.scheduledDate || c.visitDate;
        if (!dateStr) return false;
        try {
          const date = parseISO(dateStr);
          return isToday(date) || isAfter(date, today);
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const dateA = a.scheduledDate || a.visitDate || '';
        const dateB = b.scheduledDate || b.visitDate || '';
        return dateA.localeCompare(dateB);
      });
  }, [newConsultations]);

  const boardMonthLabel = `${currentYear}년 ${parseInt(currentMonth, 10)}월`;

  const parseMergedContent = (content: string) => {
    const result = { purpose: '', experience: '', injury: '', plan: '', other: '' };
    if (!content) return result;
    
    const lines = content.split('\n');
    lines.forEach(line => {
      if (line.startsWith('[운동목적]')) result.purpose = line.replace('[운동목적] ', '');
      if (line.startsWith('[운동경험]')) result.experience = line.replace('[운동경험] ', '');
      if (line.startsWith('[부상이력]')) result.injury = line.replace('[부상이력] ', '');
      if (line.startsWith('[운동계획]')) result.plan = line.replace('[운동계획] ', '');
      if (line.startsWith('[기타내용]')) result.other = line.replace('[기타내용] ', '');
    });
    return result;
  };

  const handleAddNewConsultation = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    
    const fd = new FormData(e.currentTarget);
    const id = editingConsultation ? editingConsultation.id : crypto.randomUUID();
    
    const purpose = fd.get('purpose') as string;
    const experience = fd.get('experience') as string;
    const injury = fd.get('injury') as string;
    const plan = fd.get('plan') as string;
    const other = fd.get('other') as string;
    
    const mergedContent = `[운동목적] ${purpose}\n[운동경험] ${experience}\n[부상이력] ${injury}\n[운동계획] ${plan}\n[기타내용] ${other}`;

    // Determine branch: if admin/director has selected a specific branch, use that.
    // Otherwise use the user's own branch.
    let targetBranch = user.branch;
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체') {
      targetBranch = selectedBranch as BranchType;
    }

    if (targetBranch === '본사') {
      showToast('본사는 지점이 아니므로 상담을 등록할 수 없습니다. 상단에서 지점을 선택해주세요.', 'error');
      return;
    }

    const newItem: NewConsultation = {
      ...(editingConsultation || {}),
      id,
      branch: targetBranch,
      createdAt: editingConsultation ? editingConsultation.createdAt : format(new Date(), 'yyyy-MM-dd'),
      month: editingConsultation ? editingConsultation.month : format(new Date(), 'yyyy-MM'),
      registrationStatus: fd.get('registrationStatus') as any || '미등록',
      remind1: editingConsultation ? editingConsultation.remind1 : { type: '', content: '', completed: false },
      remind2: editingConsultation ? editingConsultation.remind2 : { type: '', content: '', completed: false },
      remind3: editingConsultation ? editingConsultation.remind3 : { type: '', content: '', completed: false },
      name: fd.get('name') as string,
      contact: fd.get('contact') as string,
      visitDate: visitType === '당일' ? (fd.get('visitDate') as string) : '',
      visitTime: visitType === '당일' ? (fd.get('visitTime') as string) : '',
      scheduledDate: visitType === '예약' ? (fd.get('scheduledDate') as string) : '',
      scheduledTime: visitType === '예약' ? (fd.get('scheduledTime') as string) : '',
      gender: fd.get('gender') as '남' | '여',
      phone: fd.get('contact') as string,
      category: fd.get('category') as string,
      visitPath: fd.get('visitPath') as string,
      content: mergedContent,
      consultant: (fd.get('consultant') as string) || user.displayName,
      isCompleted: editingConsultation ? editingConsultation.isCompleted : false,
      createdBy: editingConsultation ? editingConsultation.createdBy : user.uid
    } as NewConsultation;
    
    try {
      await setDoc(doc(db, 'consultations', id), newItem);
      setIsAddingNew(false);
      setEditingConsultation(null);
      setConsultationPhone('');
      showToast('상담 정보가 성공적으로 저장되었습니다.');
      isRegisteringRef.current = false; // Reset
    } catch (error) {
      console.error('Error adding/updating consultation:', error);
      showToast('상담 저장 중 오류가 발생했습니다. 다시 시도해주세요.', 'error');
    }
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    let targetBranch = user.branch;
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체') {
      targetBranch = selectedBranch as BranchType;
    }

    if (targetBranch === '본사') {
      showToast('지점을 먼저 선택해주세요.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // Use header: 1 to get data as arrays of arrays (rows)
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        const month = selectedMonth;

        if (data.length <= 1) {
          showToast('엑셀 파일에 데이터가 없거나 헤더만 존재합니다.', 'error');
          return;
        }

        // Skip the first row (header)
        const rows = data.slice(1);
        let count = 1;
        
        // Find max 'no' in current month to continue sequence if needed
        // But usually users upload a fresh list, so starting from 1 is fine.
        // If they want to append, we should find max.
        const currentMaxNo = renewalTargets.length > 0 ? Math.max(...renewalTargets.map(t => t.no || 0)) : 0;
        count = currentMaxNo + 1;

        console.log('Starting Excel upload processing...', rows.length, 'rows found.');

        const inferRenewalCategory = (membershipText: string): string => {
          const s = (membershipText || '').toLowerCase();
          // 요청사항: 보유이용권에 '스피닝' 단어가 있으면 무조건 스피닝, 그 외(없거나 헬스권/PT만)는 헬스권
          if (s.includes('스피닝') || s.includes('spinning')) return '스피닝';
          return '헬스권';
        };

        for (const row of rows) {
          // Skip empty rows (check if name exists in column A/index 0 or B/index 1)
          const name = String(row[1] || row[0] || '').trim();
          if (!name || name === '이름' || name === '성함') continue;

          // Helper to format date from XLSX (handles both strings and serial numbers)
          const formatExcelDate = (val: any) => {
            if (!val) return '';
            if (typeof val === 'number') {
              try {
                // XLSX serial date to JS date
                const date = new Date((val - 25569) * 86400 * 1000);
                return format(date, 'yyyy-MM-dd');
              } catch {
                return String(val);
              }
            }
            return String(val).trim();
          };

          const id = crypto.randomUUID();
          const membership = String(row[6] || '').trim(); // G열 (보유 이용권)
          const target: RenewalTarget = {
            id,
            branch: targetBranch,
            no: count++, // Sequential number
            name, // B열 (이름) 또는 A열
            gender: String(row[2] || '').trim(), // C열 (성별)
            age: Number(row[4]) || 0, // E열 (나이)
            phone: String(row[5] || '').trim(), // F열 (연락처)
            membership,
            renewalCategory: inferRenewalCategory(membership),
            renewalRegistrationStatus: '미재등록',
            locker: String(row[9] || '').trim(), // J열 (락커룸/번호)
            expiryDate: formatExcelDate(row[12]), // M열 (최종만료일)
            lastAttendance: formatExcelDate(row[15]), // P열 (최근출석일)
            remind1: { type: '', content: '', completed: false },
            remind2: { type: '', content: '', completed: false },
            remind3: { type: '', content: '', completed: false },
            uploadMonth: month,
            uploadedBy: user.uid
          };
          await setDoc(doc(db, 'renewalTargets', id), target);
        }
        console.log('Excel upload complete.', count - 1, 'records saved.');
        showToast(`${count - 1}명의 데이터가 업로드되었습니다.`);
        e.target.value = ''; 
      } catch (error) {
        console.error('Excel upload error:', error);
        showToast('엑셀 파일 처리 중 오류가 발생했습니다. 파일 형식을 확인해주세요.', 'error');
      }
    };
    reader.onerror = () => {
      showToast('파일을 읽는 중 오류가 발생했습니다.', 'error');
    };
    reader.readAsBinaryString(file);
  };

  const handleConsultationExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    let targetBranch = user.branch;
    if ((user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체') {
      targetBranch = selectedBranch as BranchType;
    }
    if (targetBranch === '본사') {
      showToast('지점을 먼저 선택해주세요.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

        if (data.length <= 1) {
          showToast('엑셀/CSV 파일에 데이터가 없거나 헤더만 존재합니다.', 'error');
          return;
        }

        const rows = data.slice(1);

        const formatExcelDate = (val: any) => {
          if (!val) return '';
          if (typeof val === 'number') {
            try {
              const date = new Date((val - 25569) * 86400 * 1000);
              return format(date, 'yyyy-MM-dd');
            } catch {
              return String(val);
            }
          }
          const s = String(val).trim();
          // ex) 26.4.1 → 2026-04-01
          const m = s.match(/^(\d{2})\.(\d{1,2})\.(\d{1,2})$/);
          if (m) {
            const yy = 2000 + Number(m[1]);
            const mm = String(Number(m[2])).padStart(2, '0');
            const dd = String(Number(m[3])).padStart(2, '0');
            return `${yy}-${mm}-${dd}`;
          }
          return s;
        };

        let saved = 0;
        for (const row of rows) {
          /**
           * 엑셀 컬럼 매핑 (사용자 지정)
           * - B열(1): 등록 여부
           * - C열(2): 방문 예정일
           * - D열(3): 방문일
           * - E열(4): 성함
           * - F열(5): 남/여 (선택)
           * - G열(6): 연락처
           * - H열(7): 종목
           *
           * 그 외 컬럼은 있으면 자동 보조:
           * - I열(8): 방문경로
           * - J열(9): 상담내용(메모)
           * - K열(10): 상담자
           * - A열(0): 작성일 (없으면 오늘)
           */
          const name = String(row[4] ?? '').trim();
          if (!name || name === '성함' || name === '이름') continue;

          const rawReg = String(row[1] ?? '').trim();
          const registrationStatus: NewConsultation['registrationStatus'] =
            rawReg === '등록'
              ? '등록'
              : rawReg === '등록예정'
                ? '등록예정'
                : rawReg === '등록거부'
                  ? '등록거부'
                  : '미등록';

          const phone = String(row[6] ?? '').trim();
          const category = String(row[7] ?? '').trim();
          const visitPath = String(row[8] ?? '').trim();
          const memo = String(row[9] ?? '').trim();
          const consultant = String(row[10] ?? '').trim();

          const createdAt = formatExcelDate(row[0]) || format(new Date(), 'yyyy-MM-dd');
          const month = (createdAt || '').slice(0, 7) || format(new Date(), 'yyyy-MM');

          const scheduledDate = formatExcelDate(row[2]);
          const visitDate = formatExcelDate(row[3]);

          const genderRaw = String(row[5] ?? '').trim();
          const gender: '남' | '여' = genderRaw === '남' ? '남' : '여';

          const id = crypto.randomUUID();
          const mergedContent = memo
            ? `[운동목적] \n[운동경험] \n[부상이력] \n[운동계획] \n[기타내용] ${memo}`
            : `[운동목적] \n[운동경험] \n[부상이력] \n[운동계획] \n[기타내용] `;

          const newItem: NewConsultation = {
            id,
            branch: targetBranch,
            createdAt,
            month,
            registrationStatus,
            remind1: { type: '', content: '', completed: false },
            remind2: { type: '', content: '', completed: false },
            remind3: { type: '', content: '', completed: false },
            name,
            contact: phone,
            visitDate: visitDate || '',
            visitTime: '',
            scheduledDate: scheduledDate || '',
            scheduledTime: '',
            gender,
            phone,
            category,
            visitPath,
            content: mergedContent,
            consultant: consultant || user.displayName,
            isCompleted: false,
            createdBy: user.uid,
          };

          await setDoc(doc(db, 'consultations', id), newItem);
          saved += 1;
        }

        showToast(`${saved}건의 신규상담이 업로드되었습니다.`);
        e.target.value = '';
      } catch (error) {
        console.error('Consultation Excel upload error:', error);
        showToast('엑셀/CSV 파일 처리 중 오류가 발생했습니다. 파일 형식을 확인해주세요.', 'error');
      }
    };
    reader.onerror = () => showToast('파일을 읽는 중 오류가 발생했습니다.', 'error');
    reader.readAsBinaryString(file);
  };

  if (loading) return <div className="flex h-screen items-center justify-center bg-slate-50 font-bold text-indigo-600">로딩 중...</div>;

  if (!user) {
    return (
      <>
        <div className="flex h-screen flex-col items-center justify-center bg-slate-50 p-6">
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center">
            <div className="mb-8 flex items-center justify-center gap-3">
              <div className="h-14 w-14 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-xl">
                <Users size={32} />
              </div>
              <h1 className="text-4xl font-black tracking-tight text-slate-800">Gym 90 FC</h1>
            </div>
            <p className="mb-10 text-slate-500 font-medium">짐구공 FC 상담 관리 시스템에 오신 것을 환영합니다.</p>
            <button 
              onClick={handleLogin}
              className="flex items-center gap-3 rounded-2xl bg-white px-10 py-5 font-bold text-slate-700 shadow-lg transition-all hover:shadow-xl hover:-translate-y-1 active:scale-95"
            >
              <img src="https://www.google.com/favicon.ico" alt="Google" className="h-6 w-6" />
              구글 계정으로 시작하기
            </button>
          </motion.div>
        </div>
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 50 }}
              className={cn(
                'fixed bottom-8 left-1/2 z-[300] flex -translate-x-1/2 items-center gap-2 rounded-2xl px-6 py-3 font-bold text-white shadow-xl',
                toast.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'
              )}
            >
              {toast.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
              {toast.message}
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  // Onboarding / Registration Step
  if (user.role !== 'admin' && (!user.phoneNumber || !user.position)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md rounded-3xl bg-white p-10 shadow-2xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600">
              <UserCheck size={32} />
            </div>
            <h2 className="text-2xl font-bold text-slate-800">직원 정보 등록</h2>
            <p className="text-slate-500 mt-2">시스템 이용을 위해 정보를 입력해주세요.</p>
          </div>

          <form onSubmit={handleRegisterStaff} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700">성함</label>
              <input required name="name" defaultValue={user.displayName} type="text" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700">전화번호</label>
              <input 
                required 
                name="phone" 
                placeholder="010-0000-0000" 
                type="tel" 
                value={onboardingPhone}
                onChange={(e) => setOnboardingPhone(formatPhoneNumber(e.target.value))}
                className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700">직책</label>
              <select name="position" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700">소속 지점</label>
              <select name="branch" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <button type="submit" className="w-full rounded-2xl bg-indigo-600 py-4 font-bold text-white shadow-indigo-200 shadow-xl hover:bg-indigo-700 transition-all">
              등록 완료 및 승인 요청
            </button>
            <button type="button" onClick={handleLogout} className="w-full text-sm font-semibold text-slate-400 hover:text-slate-600">로그아웃</button>
          </form>
        </motion.div>
      </div>
    );
  }

  if (!user.isApproved && user.role !== 'admin') {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
          <AlertCircle size={80} className="mx-auto mb-6 text-amber-500" />
          <h2 className="mb-2 text-3xl font-bold text-slate-800">승인 대기 중</h2>
          <p className="max-w-md text-slate-500 font-medium">
            정보 등록이 완료되었습니다. 관리자가 확인 후 승인하면 시스템을 이용하실 수 있습니다.<br/>
            <span className="mt-4 block text-xs text-slate-400">등록된 지점: {user.branch} / 직책: {user.position}</span>
          </p>
          <button onClick={handleLogout} className="mt-10 rounded-xl border border-slate-200 px-6 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100 transition-all">로그아웃</button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Navigation */}
      <nav
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t bg-white p-4 shadow-lg",
          "md:top-0 md:bottom-auto md:left-0 md:right-auto md:flex-col md:justify-start md:gap-6 md:border-r md:border-t-0 md:h-full md:transition-[width] md:duration-200",
          isNavCollapsed ? "md:w-16" : "md:w-64"
        )}
      >
        <div className={cn("hidden md:flex flex-col items-center gap-4 px-4 py-6 w-full", isNavCollapsed && "px-2")}>
          <div className="flex items-center gap-3 w-full">
            <div className="h-10 w-10 shrink-0 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg">
              <Users size={24} />
            </div>
            {!isNavCollapsed && <h1 className="text-xl font-bold tracking-tight text-slate-800 truncate">Gym 90 FC</h1>}
          </div>
          {!isNavCollapsed && (
            <div className="w-full rounded-xl bg-slate-50 p-3 flex items-center gap-3">
              <img src={user.photoURL} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" />
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{user.displayName}</p>
                <p className="text-[10px] text-slate-500">{user.branch} / {user.role}</p>
              </div>
            </div>
          )}
          {/* Hide/Show menu button: not shown on Home */}
          {activeTab !== 'home' && (
            <button
              type="button"
              onClick={() => setIsNavCollapsed((v) => !v)}
              className={cn(
                "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-all",
                isNavCollapsed && "px-0"
              )}
              title={isNavCollapsed ? '메뉴 펼치기' : '메뉴 숨기기'}
            >
              <span className={cn("flex items-center justify-center gap-2", isNavCollapsed && "gap-0")}>
                <ChevronRight size={18} className={cn("transition-transform", isNavCollapsed ? "rotate-180" : "")} />
                {!isNavCollapsed && <span>메뉴 숨기기</span>}
              </span>
            </button>
          )}
        </div>

        <div className={cn("flex w-full justify-around md:flex-col md:gap-2 md:px-2", isNavCollapsed && "md:px-1")}>
          <NavItem collapsed={isNavCollapsed} active={activeTab === 'home'} onClick={() => setActiveTab('home')} icon={<Home size={20} />} label="홈" />
          <NavItem collapsed={isNavCollapsed} active={activeTab === 'new'} onClick={() => setActiveTab('new')} icon={<UserPlus size={20} />} label="신규상담" />
          <NavItem collapsed={isNavCollapsed} active={activeTab === 'renewal'} onClick={() => setActiveTab('renewal')} icon={<RefreshCw size={20} />} label="재등록관리" />
          {user.role === 'admin' && (
            <NavItem collapsed={isNavCollapsed} active={activeTab === 'admin'} onClick={() => setActiveTab('admin')} icon={<ShieldCheck size={20} />} label="관리자" />
          )}
          <button onClick={handleLogout} className={cn("flex flex-col items-center gap-1 px-4 py-2 text-slate-400 hover:text-rose-600 md:flex-row md:gap-3 md:w-full md:px-4 md:py-3 mt-auto", isNavCollapsed && "md:justify-center md:px-0")}>
            <LogOut size={20} />
            {!isNavCollapsed && <span className="text-[10px] font-bold md:text-sm">로그아웃</span>}
          </button>
        </div>
      </nav>

      <main className={cn("pb-24 md:pb-0 min-h-screen", isNavCollapsed ? "md:pl-16" : "md:pl-64")}>
        <div className="mx-auto max-w-6xl p-6">
          <AnimatePresence mode="wait">
            {activeTab === 'home' && (
              <motion.div key="home" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-8">
                <div className="flex items-center justify-between">
                  <header>
                    <h2 className="text-3xl font-bold text-slate-800">대시보드</h2>
                    <p className="text-slate-500">{user.branch} 지점의 주요 현황입니다.</p>
                  </header>
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                      <Calendar size={18} className="text-slate-400" />
                      <select value={currentYear} onChange={(e) => handleMonthChange(e.target.value, currentMonth)} className="text-sm font-bold outline-none bg-transparent">
                        {years.map(y => <option key={y} value={y}>{y}년</option>)}
                      </select>
                      <select value={currentMonth} onChange={(e) => handleMonthChange(currentYear, e.target.value)} className="text-sm font-bold outline-none bg-transparent">
                        {months.map(m => <option key={m} value={m}>{parseInt(m)}월</option>)}
                      </select>
                    </div>
                    <button 
                      onClick={() => { setActiveTab('new'); setIsAddingNew(true); }}
                      className="hidden sm:flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all"
                    >
                      <Plus size={20} /> 신규 상담 등록
                    </button>
                    {(user.role === 'admin' || user.role === 'director') && (
                      <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                        <Building2 size={18} className="text-slate-400" />
                        <select 
                          value={selectedBranch} 
                          onChange={(e) => setSelectedBranch(e.target.value as any)}
                          className="text-sm font-semibold outline-none bg-transparent"
                        >
                          <option value="전체">전체 지점</option>
                          {DISPLAY_BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                <div className="sm:hidden">
                  <button 
                    onClick={() => { setActiveTab('new'); setIsAddingNew(true); }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 py-4 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all"
                  >
                    <Plus size={20} /> 신규 상담 등록
                  </button>
                </div>

                <NewConsultationAnalyticsDashboard consultations={newConsultations} monthLabel={boardMonthLabel} />

                <RenewalAnalyticsDashboard targets={renewalTargets} monthLabel={boardMonthLabel} />

                <section className="grid gap-6 md:grid-cols-3">
                  <div onClick={() => { setActiveTab('new'); setIsAddingNew(true); }} className="cursor-pointer transition-transform hover:scale-[1.02] active:scale-[0.98]">
                    <StatCard title="이번 달 신규상담" value={newConsultations.length} icon={<UserPlus className="text-indigo-600" />} color="bg-indigo-50" />
                  </div>
                  <StatCard title="상담 예정자" value={upcomingVisits.length} icon={<Clock className="text-amber-600" />} color="bg-amber-50" />
                  <StatCard title="이번 달 재등록 대상" value={renewalTargets.length} icon={<RefreshCw className="text-emerald-600" />} color="bg-emerald-50" />
                </section>

                <section className="rounded-2xl border bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold flex items-center gap-2 mb-6">
                    <Calendar size={20} className="text-indigo-600" />
                    상담 예정자 안내
                  </h3>
                  {upcomingVisits.length > 0 ? (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {upcomingVisits.map((visit) => (
                          <div key={visit.id} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                            <p className="text-xs font-medium text-indigo-600 mb-1">
                              {visit.scheduledDate ? `예정: ${visit.scheduledDate} ${visit.scheduledTime}` : `방문: ${visit.visitDate} ${visit.visitTime}`}
                              <span className="ml-2 text-slate-400">({visit.branch})</span>
                            </p>
                            <h4 className="text-lg font-bold text-slate-800">{visit.name}</h4>
                            <p className="text-xs font-semibold text-indigo-600 mt-1">종목: {visit.category || '미지정'}</p>
                            <p className="text-sm text-slate-500 flex items-center gap-1 mt-1"><Phone size={12} /> {visit.contact}</p>
                            <div className="mt-4 flex items-center justify-between border-t pt-3">
                              <span className="text-xs text-slate-400">경로: {visit.visitPath}</span>
                              <div className="flex items-center gap-2">
                                <button onClick={() => startEditing(visit)} className="text-xs font-bold text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-all">상담하기</button>
                                <button onClick={async () => await updateDoc(doc(db, 'consultations', visit.id), { isCompleted: true })} className="text-xs font-semibold text-slate-400 hover:text-slate-600">완료</button>
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="py-12 text-center text-slate-400">예정된 상담이 없습니다.</div>
                  )}
                </section>
              </motion.div>
            )}

            {activeTab === 'new' && (
              <motion.div key="new" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex flex-wrap items-center gap-4">
                    <h2 className="text-3xl font-bold text-slate-800">신규상담 관리</h2>
                    <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                      <Calendar size={18} className="text-slate-400" />
                      <select value={currentYear} onChange={(e) => handleMonthChange(e.target.value, currentMonth)} className="text-sm font-bold outline-none bg-transparent">
                        {years.map(y => <option key={y} value={y}>{y}년</option>)}
                      </select>
                      <select value={currentMonth} onChange={(e) => handleMonthChange(currentYear, e.target.value)} className="text-sm font-bold outline-none bg-transparent">
                        {months.map(m => <option key={m} value={m}>{parseInt(m)}월</option>)}
                      </select>
                    </div>
                    {(user.role === 'admin' || user.role === 'director') && (
                      <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                        <Building2 size={18} className="text-slate-400" />
                        <select 
                          value={selectedBranch} 
                          onChange={(e) => setSelectedBranch(e.target.value as any)}
                          className="text-sm font-semibold outline-none bg-transparent"
                        >
                          <option value="전체">전체 지점</option>
                          {DISPLAY_BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  {isAddingNew ? (
                    <button onClick={cancelEditing} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 font-semibold text-slate-600 shadow-sm hover:bg-slate-50 transition-all">
                      목록으로 돌아가기
                    </button>
                  ) : (
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 font-semibold text-white shadow-lg hover:bg-emerald-700 transition-all">
                        <FileUp size={20} /> 엑셀/CSV 업로드
                        <input
                          type="file"
                          className="hidden"
                          accept=".xlsx, .xls, .csv"
                          onChange={handleConsultationExcelUpload}
                        />
                      </label>
                      <button onClick={() => { setEditingConsultation(null); setConsultationPhone(''); setIsAddingNew(true); }} className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white shadow-lg">
                        <Plus size={20} /> 상담 추가
                      </button>
                    </div>
                  )}
                </div>

                <NewConsultationAnalyticsDashboard consultations={newConsultations} monthLabel={boardMonthLabel} />

                {isAddingNew ? (
                  <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-3xl border bg-white p-8 shadow-xl">
                    <div className="mb-8 flex items-center justify-between">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-800">{editingConsultation ? '상담 정보 수정' : '신규 상담 등록'}</h3>
                        <p className="text-slate-500 mt-1">
                          {(user.role === 'admin' || user.role === 'director') && selectedBranch !== '전체' 
                            ? `${selectedBranch} 지점` 
                            : user.branch === '본사' ? '지점을 선택해주세요' : `${user.branch} 지점`} 상담 정보를 입력해주세요.
                        </p>
                      </div>
                      <button onClick={cancelEditing} className="p-2 text-slate-400 hover:text-slate-600">
                        <X size={24} />
                      </button>
                    </div>

                    <form onSubmit={handleAddNewConsultation} className="space-y-8">
                      {(() => {
                        const editData = editingConsultation ? {
                          ...editingConsultation,
                          ...parseMergedContent(editingConsultation.content)
                        } : null;
                        
                        return (
                          <>
                            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">성함</label>
                                <input required name="name" type="text" defaultValue={editData?.name} placeholder="고객 성함" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" />
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">연락처</label>
                                <input 
                                  required 
                                  name="contact" 
                                  type="tel" 
                                  placeholder="010-0000-0000" 
                                  value={consultationPhone}
                                  onChange={(e) => setConsultationPhone(formatPhoneNumber(e.target.value))}
                                  className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
                                />
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">상담자</label>
                                <input
                                  name="consultant"
                                  list="branch-consultants"
                                  defaultValue={editData?.consultant || user.displayName}
                                  placeholder="예: 김가영"
                                  className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all"
                                />
                                <datalist id="branch-consultants">
                                  {(branchUsers.length > 0 ? branchUsers : [user]).map((u) => (
                                    <option key={u.uid} value={u.displayName} />
                                  ))}
                                </datalist>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">방문 유형</label>
                                <div className="flex gap-4 p-1 bg-slate-50 rounded-xl border border-slate-200">
                                  <button
                                    type="button"
                                    onClick={() => setVisitType('당일')}
                                    className={cn(
                                      "flex-1 py-2 text-sm font-bold rounded-lg transition-all",
                                      visitType === '당일' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
                                    )}
                                  >
                                    당일방문
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setVisitType('예약')}
                                    className={cn(
                                      "flex-1 py-2 text-sm font-bold rounded-lg transition-all",
                                      visitType === '예약' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
                                    )}
                                  >
                                    방문예약
                                  </button>
                                </div>
                              </div>

                              {visitType === '당일' ? (
                                <div className="space-y-1.5">
                                  <label className="text-sm font-bold text-slate-700">방문일</label>
                                  <div className="flex gap-2">
                                    <input 
                                      name="visitDate" 
                                      type="date" 
                                      defaultValue={editData?.visitDate || format(new Date(), 'yyyy-MM-dd')}
                                      className="flex-1 rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
                                    />
                                    <input 
                                      name="visitTime" 
                                      type="time" 
                                      defaultValue={editData?.visitTime || format(new Date(), 'HH:mm')}
                                      className="w-32 rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1.5">
                                  <label className="text-sm font-bold text-slate-700">방문예정일</label>
                                  <div className="flex gap-2">
                                    <input 
                                      name="scheduledDate" 
                                      type="date" 
                                      defaultValue={editData?.scheduledDate || format(new Date(), 'yyyy-MM-dd')}
                                      className="flex-1 rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
                                    />
                                    <input 
                                      name="scheduledTime" 
                                      type="time" 
                                      defaultValue={editData?.scheduledTime || format(new Date(), 'HH:mm')}
                                      className="w-32 rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all" 
                                    />
                                  </div>
                                </div>
                              )}

                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">성별</label>
                                <select name="gender" defaultValue={editData?.gender || '남'} className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                                  <option value="남">남성</option>
                                  <option value="여">여성</option>
                                </select>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">종목</label>
                                <select name="category" defaultValue={editData?.category} className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">방문경로</label>
                                <select name="visitPath" defaultValue={editData?.visitPath} className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                                  {VISIT_PATHS.map(p => <option key={p} value={p}>{p}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-bold text-slate-700">가입 여부</label>
                                <select name="registrationStatus" defaultValue={editData?.registrationStatus || '미등록'} className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all">
                                  <option value="미등록">미등록</option>
                                  <option value="등록">등록</option>
                                  <option value="등록예정">등록예정</option>
                                  <option value="등록거부">등록거부</option>
                                </select>
                              </div>
                            </div>

                            <div className="space-y-4">
                              <h4 className="font-bold text-slate-800 border-b pb-2">상담 상세 내용</h4>
                              <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-1.5">
                                  <label className="text-xs font-bold text-slate-500">운동목적</label>
                                  <textarea name="purpose" defaultValue={editData?.purpose} placeholder="예: 다이어트, 근력 증진 등" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all h-24 resize-none" />
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-xs font-bold text-slate-500">운동경험</label>
                                  <textarea name="experience" defaultValue={editData?.experience} placeholder="예: 헬스 1년, 필라테스 6개월 등" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all h-24 resize-none" />
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-xs font-bold text-slate-500">부상이력</label>
                                  <textarea name="injury" defaultValue={editData?.injury} placeholder="예: 허리 디스크, 무릎 통증 등" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all h-24 resize-none" />
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-xs font-bold text-slate-500">운동계획</label>
                                  <textarea name="plan" defaultValue={editData?.plan} placeholder="예: 주 3회 PT 진행 희망 등" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all h-24 resize-none" />
                                </div>
                                <div className="space-y-1.5 sm:col-span-2">
                                  <label className="text-xs font-bold text-slate-500">기타 내용</label>
                                  <textarea name="other" defaultValue={editData?.other} placeholder="기타 참고 사항" className="w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all h-24 resize-none" />
                                </div>
                              </div>
                            </div>
                          </>
                        );
                      })()}

                      <div className="flex flex-wrap gap-3 pt-4">
                        <button 
                          type="submit" 
                          className="flex-1 min-w-[150px] rounded-2xl bg-indigo-600 py-4 font-bold text-white shadow-indigo-200 shadow-xl hover:bg-indigo-700 transition-all"
                        >
                          등록 완료
                        </button>
                        <button type="button" onClick={cancelEditing} className="px-8 rounded-2xl border border-slate-200 font-bold text-slate-500 hover:bg-slate-50 transition-all">
                          취소
                        </button>
                      </div>
                    </form>
                  </motion.div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="text-sm font-semibold text-slate-500">
                          총 {displayedNewConsultations.length}명
                        </div>
                        <input
                          value={newListSearch}
                          onChange={(e) => setNewListSearch(e.target.value)}
                          placeholder="이름/번호 검색"
                          className="h-10 w-48 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        />
                        <select
                          value={newListRegFilter}
                          onChange={(e) => setNewListRegFilter(e.target.value as any)}
                          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        >
                          <option value="전체">등록상태 전체</option>
                          <option value="미등록">미등록</option>
                          <option value="등록">등록</option>
                          <option value="등록예정">등록예정</option>
                          <option value="등록거부">등록거부</option>
                        </select>
                        <select
                          value={newListCategoryFilter}
                          onChange={(e) => setNewListCategoryFilter(e.target.value)}
                          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        >
                          <option value="전체">종목 전체</option>
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <select
                          value={newListVisitPathFilter}
                          onChange={(e) => setNewListVisitPathFilter(e.target.value)}
                          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        >
                          <option value="전체">방문경로 전체</option>
                          {VISIT_PATHS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <select
                          value={newListSortKey}
                          onChange={(e) => setNewListSortKey(e.target.value as any)}
                          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        >
                          <option value="createdAt">작성일</option>
                          <option value="visitDate">방문일</option>
                          <option value="scheduledDate">예정일</option>
                          <option value="name">성함</option>
                        </select>
                        <select
                          value={newListSortDir}
                          onChange={(e) => setNewListSortDir(e.target.value as any)}
                          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                        >
                          <option value="desc">내림차순</option>
                          <option value="asc">오름차순</option>
                        </select>
                      </div>
                      <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white shadow-lg hover:bg-emerald-700 transition-all">
                        <FileUp size={18} /> 엑셀/CSV 업로드
                        <input
                          type="file"
                          className="hidden"
                          accept=".xlsx, .xls, .csv"
                          onChange={handleConsultationExcelUpload}
                        />
                      </label>
                    </div>
                  <SyncedHorizontalScrollbar targetRef={newTableScrollRef} sticky />
                  <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                    <div ref={newTableScrollRef} className="overflow-x-auto">
                    <table className="w-full text-left min-w-[1500px]">
                      <thead className="bg-slate-50 border-b">
                        <tr>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[140px]">지점 / 성함</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">종목</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[160px]">연락처 / 성별</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[180px]">방문일 / 예정일</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">등록상태</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase min-w-[220px]">기타메모</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">상담자</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase min-w-[220px]">리마인드 (미등록 시)</th>
                          <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right">관리</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {displayedNewConsultations.map((c) => (
                          <tr key={c.id} className={cn("hover:bg-slate-50 transition-colors", c.month < selectedMonth && "bg-amber-50/30", c.isCompleted && "opacity-60")}>
                            <td className="px-6 py-4 whitespace-nowrap min-w-[140px]">
                              <div className="flex items-center gap-2 whitespace-nowrap">
                                <div className="text-xs text-slate-400 whitespace-nowrap">{c.branch}</div>
                                {c.month < selectedMonth && (
                                  <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold">이월</span>
                                )}
                              </div>
                              <div className="font-bold whitespace-nowrap">{c.name}</div>
                            </td>
                            <td className="px-6 py-4 text-sm font-semibold text-indigo-700 whitespace-nowrap">{c.category || '미지정'}</td>
                            <td className="px-6 py-4 text-sm">{c.contact}<br/><span className="text-xs text-slate-400">{c.gender}</span></td>
                            <td className="px-6 py-4 text-sm">
                              <div className="text-indigo-600 font-medium">방문: {c.visitDate || '-'} {c.visitTime}</div>
                              <div className="text-slate-500 text-xs">예정: {c.scheduledDate || '-'} {c.scheduledTime}</div>
                            </td>
                            <td className="px-6 py-4">
                              <select 
                                value={c.registrationStatus || '미등록'} 
                                onChange={async (e) =>
                                  await updateDoc(doc(db, 'consultations', c.id), {
                                    registrationStatus: e.target.value as NewConsultation['registrationStatus'],
                                  })
                                }
                                className={cn(
                                  "text-xs font-bold rounded-lg px-2 py-1 border outline-none",
                                  c.registrationStatus === '등록'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : c.registrationStatus === '등록예정'
                                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                                      : c.registrationStatus === '등록거부'
                                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                                        : 'bg-slate-50 text-slate-600 border-slate-200'
                                )}
                              >
                                <option value="등록">등록</option>
                                <option value="미등록">미등록</option>
                                <option value="등록예정">등록예정</option>
                                <option value="등록거부">등록거부</option>
                              </select>
                            </td>
                            <td className="px-6 py-4 text-xs text-slate-600 max-w-[360px]">
                              <div className="line-clamp-2">
                                {parseMergedContent(c.content).other || '-'}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-xs font-bold text-slate-700 whitespace-nowrap">
                              {c.consultant || '-'}
                            </td>
                            <td className="px-6 py-4">
                              {c.registrationStatus === '미등록' && (
                                <div className="flex items-center gap-3">
                                    {['1차', '2차', '3차'].map((num, idx) => {
                                      const field = `remind${idx + 1}` as keyof NewConsultation;
                                      const remind = c[field] as RemindInfo;
                                      return (
                                        <div key={num} className="flex flex-col items-center gap-1">
                                          <button 
                                            onClick={() => {
                                              setRemindModalContent(remind?.content ?? '');
                                              setEditingRemind({ id: c.id, type: 'new', remindIdx: idx });
                                            }}
                                            className={cn(
                                              "text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap",
                                              remind?.completed 
                                                ? "bg-indigo-50 text-indigo-700 border-indigo-200" 
                                                : "bg-slate-50 text-slate-400 border-slate-200 hover:border-slate-300"
                                            )}
                                          >
                                            {num} {remind?.type && `(${remind.type})`}
                                          </button>
                                          {remind?.content && (
                                            <div className="w-16 truncate text-[8px] text-slate-400 text-center" title={remind.content}>
                                              {remind.content}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button onClick={() => startEditing(c)} className="p-2 text-slate-400 hover:text-indigo-600"><Edit2 size={18} /></button>
                                {canDeleteRecords && (
                                  <button onClick={() => {
                                    showConfirm(
                                      '삭제 확인',
                                      '정말 삭제하시겠습니까?',
                                      async () => {
                                        try {
                                          await deleteDoc(doc(db, 'consultations', c.id));
                                          showToast('삭제되었습니다.');
                                        } catch (error) {
                                          console.error('Error deleting consultation:', error);
                                          const msg =
                                            error instanceof Error
                                              ? error.message
                                              : typeof error === 'object' && error !== null && 'message' in error
                                                ? String((error as { message: unknown }).message)
                                                : '';
                                          showToast(
                                            msg.includes('permission') ? '삭제 권한이 없습니다. 관리자만 삭제할 수 있습니다.' : '삭제 중 오류가 발생했습니다.',
                                            'error'
                                          );
                                        }
                                      }
                                    );
                                  }} className="p-2 text-slate-400 hover:text-rose-600 transition-all">
                                    <Trash2 size={18} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                  </>
                )}
              </motion.div>
            )}

            {activeTab === 'renewal' && (
              <motion.div key="renewal" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex flex-wrap items-center gap-4">
                    <h2 className="text-3xl font-bold text-slate-800">재등록 관리</h2>
                    <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                      <Calendar size={18} className="text-slate-400" />
                      <select value={currentYear} onChange={(e) => handleMonthChange(e.target.value, currentMonth)} className="text-sm font-bold outline-none bg-transparent">
                        {years.map(y => <option key={y} value={y}>{y}년</option>)}
                      </select>
                      <select value={currentMonth} onChange={(e) => handleMonthChange(currentYear, e.target.value)} className="text-sm font-bold outline-none bg-transparent">
                        {months.map(m => <option key={m} value={m}>{parseInt(m)}월</option>)}
                      </select>
                    </div>
                    {(user.role === 'admin' || user.role === 'director') && (
                      <div className="flex items-center gap-2 bg-white border rounded-xl px-3 py-2 shadow-sm">
                        <Building2 size={18} className="text-slate-400" />
                        <select 
                          value={selectedBranch} 
                          onChange={(e) => setSelectedBranch(e.target.value as any)}
                          className="text-sm font-semibold outline-none bg-transparent"
                        >
                          <option value="전체">전체 지점</option>
                          {DISPLAY_BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {canDeleteRenewalTargets && selectedRenewalIds.length > 0 && (
                      <button 
                        onClick={handleDeleteSelectedRenewals}
                        className="flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-2.5 font-semibold text-rose-600 border border-rose-100 hover:bg-rose-100 transition-all"
                      >
                        <Trash2 size={18} /> 선택 삭제 ({selectedRenewalIds.length})
                      </button>
                    )}
                    {canDeleteRenewalTargets && (
                      <button 
                        onClick={handleDeleteAllRenewals}
                        className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-2.5 font-semibold text-slate-600 border border-slate-200 hover:bg-slate-100 transition-all"
                      >
                        <RefreshCw size={18} /> 전체 삭제
                      </button>
                    )}
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 font-semibold text-white shadow-lg hover:bg-emerald-700 transition-all">
                      <FileUp size={20} /> 엑셀 업로드
                      <input type="file" className="hidden" accept=".xlsx, .xls" onChange={handleExcelUpload} />
                    </label>
                  </div>
                </div>

                <RenewalAnalyticsDashboard targets={renewalTargets} monthLabel={boardMonthLabel} />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="text-sm font-semibold text-slate-500">
                      총 {displayedRenewalTargets.length}명
                    </div>
                    <input
                      value={renewalListSearch}
                      onChange={(e) => setRenewalListSearch(e.target.value)}
                      placeholder="이름/번호 검색"
                      className="h-10 w-48 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                    />
                    <select
                      value={renewalListStatusFilter}
                      onChange={(e) => setRenewalListStatusFilter(e.target.value as any)}
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                    >
                      <option value="전체">재등록상태 전체</option>
                      <option value="미재등록">미재등록</option>
                      <option value="재등록 예정">재등록 예정</option>
                      <option value="재등록">재등록</option>
                      <option value="재등록거부">재등록거부</option>
                    </select>
                    <select
                      value={renewalListCategoryFilter}
                      onChange={(e) => setRenewalListCategoryFilter(e.target.value)}
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                    >
                      <option value="전체">종목 전체</option>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <select
                      value={renewalListSortKey}
                      onChange={(e) => setRenewalListSortKey(e.target.value as any)}
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                    >
                      <option value="no">순번</option>
                      <option value="expiryDate">만료일</option>
                      <option value="name">성함</option>
                    </select>
                    <select
                      value={renewalListSortDir}
                      onChange={(e) => setRenewalListSortDir(e.target.value as any)}
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:ring-4 focus:ring-indigo-50"
                    >
                      <option value="asc">오름차순</option>
                      <option value="desc">내림차순</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openCreateRenewalTarget}
                      className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white shadow-lg hover:bg-indigo-700 transition-all"
                    >
                      <Plus size={18} /> 회원 추가
                    </button>
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white shadow-lg hover:bg-emerald-700 transition-all">
                      <FileUp size={18} /> 엑셀 업로드
                      <input
                        type="file"
                        className="hidden"
                        accept=".xlsx, .xls"
                        onChange={handleExcelUpload}
                      />
                    </label>
                  </div>
                </div>

                <SyncedHorizontalScrollbar targetRef={renewalTableScrollRef} sticky />
                <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                  <div ref={renewalTableScrollRef} className="overflow-x-auto">
                  <table className="w-full text-left min-w-[1700px]">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-4 py-4 w-10">
                          <input 
                            type="checkbox" 
                            className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            checked={renewalTargets.length > 0 && selectedRenewalIds.length === renewalTargets.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRenewalIds(renewalTargets.map(t => t.id));
                              } else {
                                setSelectedRenewalIds([]);
                              }
                            }}
                          />
                        </th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[72px]">순번</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[140px]">지점 / 이름</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[72px]">성별</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[72px]">나이</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[150px]">연락처</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[220px]">보유 이용권</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">종목</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[120px]">재등록 상태</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[120px]">락커룸/번호</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap text-rose-500 min-w-[120px]">최종만료일</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap min-w-[120px]">최근출석일</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase min-w-[200px]">TM 현황</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right">관리</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {displayedRenewalTargets.map((t) => (
                        <tr key={t.id} className={cn("hover:bg-slate-50 transition-colors", selectedRenewalIds.includes(t.id) && "bg-indigo-50/30")}>
                          <td className="px-4 py-4">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              checked={selectedRenewalIds.includes(t.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRenewalIds([...selectedRenewalIds, t.id]);
                                } else {
                                  setSelectedRenewalIds(selectedRenewalIds.filter(id => id !== t.id));
                                }
                              }}
                            />
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500 whitespace-nowrap">{t.no}</td>
                          <td className="px-6 py-4 whitespace-nowrap min-w-[140px]">
                            <div className="text-[10px] text-slate-400 whitespace-nowrap">{t.branch}</div>
                            <div className="font-bold text-sm whitespace-nowrap">{t.name}</div>
                          </td>
                          <td className="px-6 py-4 text-sm whitespace-nowrap">{t.gender}</td>
                          <td className="px-6 py-4 text-sm whitespace-nowrap">{t.age}세</td>
                          <td className="px-6 py-4 text-sm whitespace-nowrap">{t.phone}</td>
                          <td className="px-6 py-4 text-sm min-w-[220px]">
                            <div className="break-words whitespace-normal leading-snug">{t.membership}</div>
                          </td>
                          <td className="px-6 py-4">
                            <select
                              value={t.renewalCategory || '헬스권'}
                              onChange={async (e) =>
                                await updateDoc(doc(db, 'renewalTargets', t.id), { renewalCategory: e.target.value })
                              }
                              className="max-w-[120px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-100"
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-6 py-4">
                            <select
                              value={t.renewalRegistrationStatus || '미재등록'}
                              onChange={async (e) =>
                                await updateDoc(doc(db, 'renewalTargets', t.id), {
                                  renewalRegistrationStatus: e.target.value as RenewalRegistrationStatus,
                                })
                              }
                              className={cn(
                                'w-full min-w-[108px] max-w-[130px] rounded-lg border px-2 py-1.5 text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-100',
                                t.renewalRegistrationStatus === '재등록'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                  : t.renewalRegistrationStatus === '재등록 예정'
                                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                                    : t.renewalRegistrationStatus === '재등록거부'
                                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                                    : 'border-slate-200 bg-slate-50 text-slate-600'
                              )}
                            >
                              {RENEWAL_REGISTRATION_OPTIONS.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-6 py-4 text-sm">{t.locker}</td>
                          <td className="px-6 py-4 text-sm font-bold text-rose-500">{t.expiryDate}</td>
                          <td className="px-6 py-4 text-sm">{t.lastAttendance}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              {['1차', '2차', '3차'].map((num, idx) => {
                                const field = `remind${idx + 1}` as keyof RenewalTarget;
                                const remind = t[field] as RemindInfo;
                                return (
                                  <div key={num} className="flex flex-col items-center gap-1">
                                    <button 
                                      onClick={() => {
                                        setRemindModalContent(remind?.content ?? '');
                                        setEditingRemind({ id: t.id, type: 'renewal', remindIdx: idx });
                                      }}
                                      className={cn(
                                        "text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap",
                                        remind?.completed 
                                          ? "bg-indigo-50 text-indigo-700 border-indigo-200" 
                                          : "bg-slate-50 text-slate-400 border-slate-200 hover:border-slate-300"
                                      )}
                                    >
                                      {num} {remind?.type && `(${remind.type})`}
                                    </button>
                                    {remind?.content && (
                                      <div className="w-16 truncate text-[8px] text-slate-400 text-center" title={remind.content}>
                                        {remind.content}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => setEditingRenewalTarget(t)} className="p-2 text-slate-400 hover:text-indigo-600 transition-all">
                                <Edit2 size={18} />
                              </button>
                              {canDeleteRenewalTargets && (
                                <button onClick={() => {
                                  showConfirm(
                                    '삭제 확인',
                                    '정말 삭제하시겠습니까?',
                                    async () => {
                                      try {
                                        await deleteDoc(doc(db, 'renewalTargets', t.id));
                                        showToast('삭제되었습니다.');
                                      } catch (error) {
                                        console.error('Error deleting renewal target:', error);
                                        const msg =
                                          error instanceof Error
                                            ? error.message
                                            : typeof error === 'object' && error !== null && 'message' in error
                                              ? String((error as { message: unknown }).message)
                                              : '';
                                        showToast(
                                          msg.includes('permission')
                                            ? '삭제 권한이 없습니다. (지점 권한/승인 상태를 확인해주세요)'
                                            : '삭제 중 오류가 발생했습니다.',
                                          'error'
                                        );
                                      }
                                    }
                                  );
                                }} className="p-2 text-slate-400 hover:text-rose-600 transition-all">
                                  <Trash2 size={18} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'admin' && user.role === 'admin' && (
              <motion.div key="admin" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
                <h2 className="text-3xl font-bold text-slate-800">사용자 관리</h2>
                <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">사용자</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">지점 / 권한</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase">승인 상태</th>
                        <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase text-right">관리</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {allUsers.map((u) => (
                        <tr key={u.uid} className="hover:bg-slate-50">
                          <td className="px-6 py-4 flex items-center gap-3">
                            <img src={u.photoURL} alt="" className="h-10 w-10 rounded-full shadow-sm" referrerPolicy="no-referrer" />
                            <div>
                              <div className="font-bold text-sm text-slate-800">{u.displayName}</div>
                              <div className="text-xs text-slate-400">{u.email}</div>
                              <div className="mt-1 flex items-center gap-2">
                                <span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-bold">{u.position || '직책 미등록'}</span>
                                <span className="text-[10px] text-slate-400 font-medium">{u.phoneNumber || '전화번호 미등록'}</span>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <select 
                                value={u.branch} 
                                onChange={(e) => handleUpdateUserRole(u.uid, u.role, e.target.value as BranchType)}
                                className="text-xs border rounded p-1"
                              >
                                {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                              </select>
                              <select 
                                value={u.role} 
                                onChange={(e) => handleUpdateUserRole(u.uid, e.target.value as UserRole, u.branch)}
                                className="text-xs border rounded p-1"
                              >
                                <option value="staff">직원</option>
                                <option value="director">이사</option>
                                <option value="admin">관리자</option>
                              </select>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", u.isApproved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
                              {u.isApproved ? '승인됨' : '대기중'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => handleApproveUser(u.uid, !u.isApproved)}
                              className={cn("text-xs font-bold px-3 py-1.5 rounded-lg border transition-all", u.isApproved ? "text-rose-600 border-rose-200 hover:bg-rose-50" : "text-emerald-600 border-emerald-200 hover:bg-emerald-50")}
                            >
                              {u.isApproved ? '승인취소' : '승인하기'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Reminder Edit Modal */}
      {editingRemind && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-slate-800">{editingRemind.remindIdx + 1}차 TM 상세</h3>
              <button onClick={() => setEditingRemind(null)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
            </div>
            
            {/* AI Generation Options */}
            <div className="mb-6 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100 space-y-4">
              <div className="flex items-center gap-2 text-indigo-700 font-bold mb-2">
                <RefreshCw size={18} className={cn(isGeneratingAI && "animate-spin")} />
                <span>AI 문구 생성 옵션</span>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-600">말투</label>
                  <div
                    className="grid w-full grid-cols-2 gap-1 rounded-2xl border border-indigo-200 bg-white p-1 shadow-sm"
                    role="group"
                    aria-label="말투 선택"
                  >
                    {AI_TONE_CHOICES.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={aiOptions.tone === o.value}
                        onClick={() => setAiOptions({ ...aiOptions, tone: o.value })}
                        className={cn(
                          'min-h-11 rounded-xl px-2 py-2.5 text-sm font-bold transition-all',
                          aiOptions.tone === o.value
                            ? 'bg-indigo-600 text-white shadow-md'
                            : 'text-slate-600 hover:bg-indigo-50'
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-600">혜택</label>
                  <div
                    className="flex w-full flex-col gap-1 rounded-2xl border border-indigo-200 bg-white p-1 shadow-sm sm:flex-row"
                    role="group"
                    aria-label="혜택 선택"
                  >
                    {AI_BENEFIT_CHOICES.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={aiOptions.benefit === o.value}
                        onClick={() => setAiOptions({ ...aiOptions, benefit: o.value })}
                        className={cn(
                          'min-h-11 flex-1 rounded-xl px-2 py-2.5 text-sm font-bold transition-all sm:text-center',
                          aiOptions.benefit === o.value
                            ? 'bg-indigo-600 text-white shadow-md'
                            : 'text-slate-600 hover:bg-indigo-50'
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-600">일정</label>
                  <div
                    className="grid w-full grid-cols-2 gap-1 rounded-2xl border border-indigo-200 bg-white p-1 shadow-sm"
                    role="group"
                    aria-label="일정 선택"
                  >
                    {AI_SCHEDULE_CHOICES.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={aiOptions.schedule === o.value}
                        onClick={() => setAiOptions({ ...aiOptions, schedule: o.value })}
                        className={cn(
                          'min-h-11 rounded-xl px-2 py-2.5 text-sm font-bold transition-all',
                          aiOptions.schedule === o.value
                            ? 'bg-indigo-600 text-white shadow-md'
                            : 'text-slate-600 hover:bg-indigo-50'
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500">추가 정보/혜택 (직접 입력)</label>
                <input 
                  type="text"
                  value={aiOptions.additionalInfo}
                  onChange={(e) => setAiOptions({...aiOptions, additionalInfo: e.target.value})}
                  placeholder="예: PT 2회 추가, 락커 무료 등"
                  className="w-full text-xs p-2 rounded-lg border border-indigo-200 bg-white outline-none focus:ring-2 focus:ring-indigo-200"
                />
              </div>
              <button 
                type="button"
                onClick={handleGenerateAI}
                disabled={isGeneratingAI}
                className="w-full py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold shadow-md hover:bg-indigo-700 disabled:opacity-50 transition-all"
              >
                {isGeneratingAI ? '생성 중...' : 'AI 문구 생성하기'}
              </button>
            </div>

            <form id="remind-form" onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const type = fd.get('type') as '문자' | '전화' | '';
              const content = fd.get('content') as string;
              const completed = fd.get('completed') === 'on';
              
              const field = `remind${editingRemind.remindIdx + 1}`;
              const collectionName = editingRemind.type === 'new' ? 'consultations' : 'renewalTargets';
              await updateDoc(doc(db, collectionName, editingRemind.id), {
                [field]: { type, content, completed }
              });
              setEditingRemind(null);
            }} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-slate-700">TM 방식</label>
                <select name="type" defaultValue={(() => {
                  const target = editingRemind.type === 'new' 
                    ? newConsultations.find(c => c.id === editingRemind.id)
                    : renewalTargets.find(t => t.id === editingRemind.id);
                  return (target?.[`remind${editingRemind.remindIdx + 1}` as keyof typeof target] as RemindInfo)?.type || '';
                })()} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all">
                  <option value="">선택하세요</option>
                  <option value="문자">문자</option>
                  <option value="전화">전화</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-bold text-slate-700">상담 내용</label>
                  <button
                    type="button"
                    onClick={copyRemindContentToClipboard}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 shadow-sm hover:bg-slate-50 transition-all"
                  >
                    <Copy size={14} />
                    복사하기
                  </button>
                </div>
                <textarea
                  id="remind-content"
                  name="content"
                  value={remindModalContent}
                  onChange={(e) => setRemindModalContent(e.target.value)}
                  placeholder="상담 내용을 입력하세요"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all h-32 resize-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="completed" id="remind-completed" defaultChecked={(() => {
                  const target = editingRemind.type === 'new' 
                    ? newConsultations.find(c => c.id === editingRemind.id)
                    : renewalTargets.find(t => t.id === editingRemind.id);
                  return (target?.[`remind${editingRemind.remindIdx + 1}` as keyof typeof target] as RemindInfo)?.completed || false;
                })()} className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500" />
                <label htmlFor="remind-completed" className="text-sm font-bold text-slate-700 cursor-pointer">완료 여부</label>
              </div>
              <div className="flex gap-2 pt-4">
                <button type="submit" className="flex-1 rounded-xl bg-indigo-600 py-3 font-bold text-white shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">저장</button>
                <button type="button" onClick={() => setEditingRemind(null)} className="flex-1 rounded-xl border border-slate-200 py-3 font-bold text-slate-500 hover:bg-slate-50 transition-all">취소</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {/* Renewal Target Edit Modal */}
      {editingRenewalTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-2xl rounded-3xl bg-white p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-slate-800">{isCreatingRenewalTarget ? '재등록 대상 추가' : '재등록 정보 수정'}</h3>
              <button onClick={() => { setEditingRenewalTarget(null); setIsCreatingRenewalTarget(false); }} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
            </div>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const rs = fd.get('renewalRegistrationStatus') as string;
              const renewalRegistrationStatus: RenewalRegistrationStatus =
                rs === '재등록' || rs === '재등록 예정' || rs === '미재등록' || rs === '재등록거부' ? rs : '미재등록';
              const updates = {
                no: Number(fd.get('no')) || editingRenewalTarget.no,
                name: fd.get('name') as string,
                gender: fd.get('gender') as string,
                age: Number(fd.get('age')) || 0,
                phone: fd.get('phone') as string,
                membership: fd.get('membership') as string,
                renewalCategory: (fd.get('renewalCategory') as string) || '헬스권',
                renewalRegistrationStatus,
                locker: fd.get('locker') as string,
                expiryDate: fd.get('expiryDate') as string,
                lastAttendance: fd.get('lastAttendance') as string,
              };
              if (isCreatingRenewalTarget) {
                if (!user) return;
                const newDoc: RenewalTarget = {
                  ...(editingRenewalTarget as RenewalTarget),
                  ...updates,
                  uploadMonth: selectedMonth,
                  uploadedBy: user.uid,
                };
                await setDoc(doc(db, 'renewalTargets', editingRenewalTarget.id), newDoc);
                showToast('추가되었습니다.');
              } else {
                await updateDoc(doc(db, 'renewalTargets', editingRenewalTarget.id), updates);
                showToast('수정되었습니다.');
              }
              setEditingRenewalTarget(null);
              setIsCreatingRenewalTarget(false);
            }} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">순번</label>
                  <input type="number" name="no" defaultValue={editingRenewalTarget.no} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">이름</label>
                  <input name="name" defaultValue={editingRenewalTarget.name} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">연락처</label>
                  <input name="phone" defaultValue={editingRenewalTarget.phone} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">성별</label>
                  <select name="gender" defaultValue={editingRenewalTarget.gender} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all">
                    <option value="남">남</option>
                    <option value="여">여</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">나이</label>
                  <input type="number" name="age" defaultValue={editingRenewalTarget.age} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">보유 이용권</label>
                  <input name="membership" defaultValue={editingRenewalTarget.membership} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">종목</label>
                  <select
                    name="renewalCategory"
                    defaultValue={editingRenewalTarget.renewalCategory || '헬스권'}
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-sm font-bold text-slate-700">재등록 상태</label>
                  <select
                    name="renewalRegistrationStatus"
                    defaultValue={editingRenewalTarget.renewalRegistrationStatus || '미재등록'}
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all"
                  >
                    {RENEWAL_REGISTRATION_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">락커룸/번호</label>
                  <input name="locker" defaultValue={editingRenewalTarget.locker} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">최종만료일</label>
                  <input name="expiryDate" defaultValue={editingRenewalTarget.expiryDate} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700">최근출석일</label>
                  <input name="lastAttendance" defaultValue={editingRenewalTarget.lastAttendance} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                </div>
              </div>
              <div className="flex gap-2 pt-4">
                <button type="submit" className="flex-1 rounded-xl bg-indigo-600 py-3 font-bold text-white shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">저장</button>
                <button type="button" onClick={() => { setEditingRenewalTarget(null); setIsCreatingRenewalTarget(false); }} className="flex-1 rounded-xl border border-slate-200 py-3 font-bold text-slate-500 hover:bg-slate-50 transition-all">취소</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal?.isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800 mb-2">{confirmModal.title}</h3>
            <p className="text-slate-600 mb-6">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button 
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="flex-1 rounded-xl bg-rose-600 py-3 font-bold text-white hover:bg-rose-700 transition-all"
              >
                확인
              </button>
              <button 
                onClick={() => setConfirmModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-bold text-slate-500 hover:bg-slate-50 transition-all"
              >
                취소
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: 50 }}
            className={cn(
              "fixed bottom-8 left-1/2 -translate-x-1/2 z-[300] px-6 py-3 rounded-2xl shadow-xl font-bold text-white flex items-center gap-2",
              toast.type === 'success' ? "bg-emerald-600" : "bg-rose-600"
            )}
          >
            {toast.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  collapsed,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 px-4 py-2 rounded-xl transition-all md:flex-row md:gap-3 md:w-full md:px-4 md:py-3",
        collapsed && "md:justify-center md:px-0",
        active ? "text-indigo-600 bg-indigo-50" : "text-slate-400 hover:text-slate-600 hover:bg-slate-50"
      )}
      title={collapsed ? label : undefined}
    >
      {icon}
      <span className={cn("text-[10px] font-bold md:text-sm", collapsed && "md:hidden")}>{label}</span>
    </button>
  );
}

function StatCard({ title, value, icon, color }: { title: string; value: number; icon: React.ReactNode; color: string }) {
  return (
    <div className="rounded-2xl border bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className={cn("p-3 rounded-xl", color)}>{icon}</div>
        <span className="text-2xl font-black text-slate-800">{value}</span>
      </div>
      <p className="text-sm font-medium text-slate-500">{title}</p>
    </div>
  );
}
