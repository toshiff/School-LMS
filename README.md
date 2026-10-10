# School LMS – Online Examination

Online exams on top of **School Edtech** (`school_edtech`). Requires that app on the same site.

## How it links to School Edtech

| Here | Comes from |
|---|---|
| Logged-in student | `Student` where `email_address` = login user |
| Class, Section, Roll No., Academic Year | Student's `academic_details` (Current Class CT); the row whose Academic Year is enabled |
| Class / Subject / Section / Exam Type / Topic | `Class`, `Subject`, `Student Section`, `Exam Type`, `Topic` |
| Roles | Student, Teacher, Examination Admin, Academic Admin, System Manager |

## DocTypes

- **Exam Question** – question bank per Class + Subject (+ Topic, Difficulty). Types:
  Single Choice (MCQ), Multiple Choice (MSQ), True / False, Fill in the Blank, Numeric (auto-marked);
  Short Answer, Long Answer, Drawing (teacher-marked). Images, negative marks, word limit,
  drawing background (e.g. outline map), model answer / marking guide.
- **Exam Paper** (submittable) – Class, optional Section (empty = all sections), Subject, Academic Year,
  Exam Date + Start Time + Duration. A student who joins late only gets the time left until the end.
  Questions picked by hand or with **Add Questions from Bank** (random by topic/type/difficulty).
  Shuffle questions/options, auto-submit after N times leaving the exam, Publish Result.
  Date/time/duration can be changed after submit (postpone/extend); running attempts follow.
- **Exam Submission** – one per student per exam (`<exam>-<student>`), answers, marks, status
  (In Progress → Submitted → Evaluated), proctoring log.

## Pages

- `/app/my-exams` – student: details, live/upcoming/finished exams with countdowns, exam screen
  (question palette, mark for review, autosave every ~25 s + device backup, drawing pad, full-screen lockdown).
- `/app/answer-evaluation` – teacher: mark subjective and drawing answers, override auto marks, remarks.
- Workspace **Student LMS** for teachers/admins.

## Install

```bash
cd ~/frappe-bench
bench get-app https://github.com/toshiff/School-LMS
bench --site <site> install-app school_lms
bench --site <site> migrate
```

The scheduler must be enabled (`bench --site <site> enable-scheduler`) so attempts whose time ran out
are submitted automatically.
