export type BranchType = '본사' | '쌍문점' | '외대점' | '길동점' | '시청점' | '시청역점' | '광화문점' | '노원점';
export type UserRole = 'staff' | 'director' | 'admin';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: UserRole;
  branch: BranchType;
  position: string;
  phoneNumber: string;
  isApproved: boolean;
  createdAt: string;
}

export interface RemindInfo {
  type: '문자' | '전화' | '';
  content: string;
  completed: boolean;
}

export interface NewConsultation {
  id: string;
  branch: BranchType;
  createdAt: string;
  month: string;
  registrationStatus: '등록' | '미등록' | '등록예정' | '등록거부';
  remind1: RemindInfo;
  remind2: RemindInfo;
  remind3: RemindInfo;
  name: string;
  contact: string;
  visitDate: string;
  visitTime: string;
  scheduledDate: string;
  scheduledTime: string;
  gender: '남' | '여';
  phone: string;
  category: string;
  visitPath: string;
  content: string;
  consultant: string;
  isCompleted: boolean;
  createdBy: string;
}

export type RenewalRegistrationStatus = '재등록' | '재등록 예정' | '미재등록' | '재등록거부';

export interface RenewalTarget {
  id: string;
  branch: BranchType;
  no: number; // 순번
  name: string;
  gender: string;
  age: number;
  phone: string;
  membership: string; // 보유 이용권
  /** 상담 종목과 동일 옵션 (헬스권, PT, 스피닝 등) */
  renewalCategory: string;
  /** 재등록 진행 상태 */
  renewalRegistrationStatus: RenewalRegistrationStatus;
  locker: string; // 락커룸/락커번호
  expiryDate: string; // 최종만료일
  lastAttendance: string; // 최근출석일
  remind1: RemindInfo; // 1차 TM
  remind2: RemindInfo; // 2차 TM
  remind3: RemindInfo; // 3차 TM
  uploadMonth: string;
  uploadedBy: string;
}
