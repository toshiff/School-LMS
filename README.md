# School LMS – Online Exam (proof of concept)

- **Exam Question**: class-wise MCQ question bank (4 options, correct option, marks).
- **Online Exam page** (`/app/online-exam`): pick a class, get 5 random questions, 10-minute timer, submit.
- **Exam Submission**: one record per attempt, with each question, the student's answer, the correct answer and marks.

## Install (on a test site)

```bash
cd ~/frappe-bench
bench get-app ~/school_lms
bench --site <test-site> install-app school_lms
bench --site <test-site> migrate
sudo supervisorctl restart frappe-bench-web: frappe-bench-workers:
```

## Test

1. Open **Exam Question** and add at least 5 questions for a class (e.g. `Class 10`).
2. Log in as a test user (a System User without the System Manager role) and open `/app/online-exam`.
3. Pick the class, answer, submit (or let the timer run out).
4. As admin, open **Exam Submission** to see answers stored per question.

Settings are constants at the top of `school_lms/api.py` (`EXAM_MINUTES`, `QUESTION_COUNT`, `GRACE_SECONDS`).
