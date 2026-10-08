#!/usr/bin/env python3
"""Convert the local Made Easy GATE CE HTML papers to the site's question format."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from html import unescape
from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/home/niru/Documents/Made Easy Test Series 2026')
OUT = ROOT / 'data' / 'made-easy'
IMAGE_DIR = ROOT / 'data' / 'images' / 'made-easy'


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def fragment(node) -> str:
    return ''.join(str(child) for child in node.contents).strip()


def plain(node) -> str:
    return ' '.join(node.stripped_strings).replace('\xa0', ' ').strip()


def save_images(markup: str, image_refs: list[dict]) -> str:
    soup = BeautifulSoup(markup, 'html.parser')
    for image in soup.find_all('img'):
        src = image.get('src', '')
        if src.startswith('data:image/'):
            header, encoded = src.split(',', 1)
            mime = header.split(';', 1)[0].split('/', 1)[-1].lower()
            ext = {'jpeg': 'jpg', 'svg+xml': 'svg'}.get(mime, mime)
            raw = base64.b64decode(encoded)
            digest = hashlib.sha256(raw).hexdigest()
            name = f'{digest}.{ext}'
            IMAGE_DIR.mkdir(parents=True, exist_ok=True)
            target = IMAGE_DIR / name
            if not target.exists():
                target.write_bytes(raw)
            image_refs.append({'localPath': f'data/images/made-easy/{name}', 'altText': image.get('alt') or 'Made Easy test figure'})
            image['src'] = '/made-easy-embedded-image'
        elif src:
            # The source papers are self-contained; retain any non-data image as a safe external reference.
            image_refs.append({'url': src if src.startswith('https://') else '', 'altText': image.get('alt') or 'Made Easy test figure'})
    return ''.join(str(child) for child in soup.contents)


def group_for(name: str) -> str:
    low = name.lower()
    if 'ese' in low:
        if 'demo test' in low:
            return 'ESE demo tests'
        if 'full syllabus' in low:
            return 'ESE full syllabus tests'
        return 'ESE subject-wise tests'
    if 'advance level' in low:
        return 'Advanced full syllabus'
    if 'basic level' in low:
        return 'Basic full syllabus'
    if 'mock level' in low or 'demo test' in low:
        return 'Mock tests'
    if 'subjectwise' in low or 'subject-wise' in low:
        return 'Subject-wise tests'
    return 'Topic-wise tests'


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    catalog = []
    for source in sorted(SOURCE.glob('*.html')):
        text = source.read_text(encoding='utf-8', errors='replace')
        soup = BeautifulSoup(text, 'html.parser')
        title = unescape(soup.title.get_text(' ', strip=True)) if soup.title else source.stem
        questions = []
        for card in soup.select('section.qcard[data-qnum]'):
            qnum = int(card.get('data-qnum') or len(questions) + 1)
            qtype = (card.get('data-qtype') or 'MCQ').upper()
            tags = card.select_one('.tags')
            tag_parts = [part.strip() for part in (tags.get_text(' • ', strip=True).split('•') if tags else []) if part.strip()]
            first_tag = tag_parts[0] if tag_parts else 'Civil Engineering'
            subject = first_tag if 'aptitude' in first_tag.lower() else 'Civil Engineering'
            topic = first_tag if subject != 'Civil Engineering' else (tag_parts[1] if len(tag_parts) > 1 else first_tag)
            qnode = card.select_one('.qtext')
            question_images: list[dict] = []
            qmarkup = save_images(fragment(qnode), question_images) if qnode else ''
            options = []
            for option in card.select('.opts label.opt'):
                key = option.get('data-opt', '').strip()
                body = option.find('div')
                if body:
                    leading = body.find(['b', 'strong'])
                    if leading and leading.get_text(' ', strip=True).strip().rstrip('.') == key:
                        leading.decompose()
                    option_html = fragment(body)
                    option_text = plain(body)
                else:
                    option_html = fragment(option)
                    option_text = plain(option)
                option_images: list[dict] = []
                options.append({'key': key, 'html': save_images(option_html, option_images), 'text': option_text, 'images': option_images})
            correct = [x.strip().upper() for x in re.split(r'[,;\s]+', card.get('data-correct', '').strip()) if x.strip()]
            solution = card.select_one('details.solution')
            if not correct and solution:
                solution_text = plain(solution)
                key = re.match(r'^Solution\s*\(?([A-D](?:\s*,\s*[A-D])*)\)?(?:\s|$)', solution_text, re.I)
                if key:
                    correct = [letter.upper() for letter in re.findall(r'[A-D]', key.group(1), re.I)]
            if len(correct) > 1:
                qtype = 'MSQ'
            right = float(card.get('data-right') or 0)
            negative = float(card.get('data-wrong') or 0)
            nat_answer = None
            nat_low = card.get('data-nat-low')
            nat_high = card.get('data-nat-high')
            if qtype == 'NAT' and nat_low and nat_high:
                nat_answer = {'min': float(nat_low), 'max': float(nat_high)}
            explanation_images: list[dict] = []
            explanation_html = ''
            if solution:
                summary = solution.find('summary')
                if summary:
                    summary.decompose()
                explanation_html = save_images(fragment(solution), explanation_images)
            content = {
                'id': f'madeeasy-{slug(source.stem)}-q{qnum}',
                'subject': subject,
                'topic': topic,
                'year': 2026,
                'session': 'Made Easy',
                'questionNo': qnum,
                'type': qtype,
                'marks': right,
                'negativeMarks': negative,
                'questionMarkup': qmarkup,
                'questionText': plain(qnode) if qnode else '',
                'options': options,
                'correctAnswer': correct,
                'natAnswer': nat_answer,
                'natAnswerRaw': f'{nat_low}–{nat_high}' if nat_answer else None,
                'answerStatus': 'available' if (correct or nat_answer is not None) else 'pending',
                'images': question_images,
                'explanationHtml': explanation_html,
                'explanationImages': explanation_images,
                'explanationText': None,
                'madeEasy': True,
            }
            questions.append(content)
        if not questions:
            continue
        file = f'{slug(source.stem)}.json'
        duration = int((soup.select_one('#timerWrap') or {}).get('data-duration') or 0)
        exam_label = 'ESE 2026 CE' if 'ESE' in source.name.upper() else 'GATE 2026 CE'
        payload = {'id': file[:-5], 'title': title, 'group': group_for(source.name), 'examLabel': exam_label, 'durationSeconds': duration, 'sourceFile': source.name, 'questionCount': len(questions), 'questions': questions}
        (OUT / file).write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        catalog.append({key: payload[key] for key in ('id', 'title', 'group', 'examLabel', 'durationSeconds', 'questionCount') } | {'file': file})
        print(f'{source.name}: {len(questions)} questions')
    (OUT / 'manifest.json').write_text(json.dumps({'version': 1, 'provider': 'Made Easy', 'tests': catalog}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(catalog)} Made Easy tests ({sum(test["questionCount"] for test in catalog)} questions).')


if __name__ == '__main__':
    main()
