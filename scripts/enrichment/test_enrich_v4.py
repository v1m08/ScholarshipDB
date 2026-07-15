"""Offline contract tests for enrich_v4.py."""

from __future__ import annotations

import asyncio
import copy
import json
from io import BytesIO
import os
import unittest
from unittest.mock import MagicMock, patch

import enrich_v4


class EnrichmentV4Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.taxonomy = enrich_v4.load_json(enrich_v4.TAXONOMY_PATH)
        cls.record = {
            "id": "test-record",
            "title": "Engineering Scholarship",
            "provider": "Example Foundation",
            "description": "For engineering students.",
            "applicationUrl": "https://example.com/apply",
            "sourceUrl": "https://example.com/scholarship",
            "award": {"maximum": 1000, "varies": False},
            "requirements": {},
            "eligibility": {"fields": ["Engineering"], "other": []},
        }

    def test_taxonomy_is_closed_unique_and_consistent(self):
        tags = self.taxonomy["tags"]
        ids = [tag["id"] for tag in tags]
        self.assertEqual(len(ids), len(set(ids)))
        known = set(ids)
        for tag in tags:
            self.assertIn(tag["category"], {category["id"] for category in self.taxonomy["categories"]})
            self.assertIn(tag["assignment"], {
                "eligible", "required", "preferred", "required-or-preferred", "descriptive"
            })
            self.assertTrue(set(tag.get("implies", [])).issubset(known))
            if tag.get("frontend"):
                self.assertIn(tag.get("frontendGroup"), self.taxonomy["frontendGroups"])
        self.assertTrue(set(self.taxonomy["aliases"].values()).issubset(known))

    def test_model_json_parser_ignores_surrounding_text(self):
        value = enrich_v4.parse_json_object('analysis first\n```json\n{"id":"x","ok":true}\n```\n')
        self.assertEqual(value, {"id": "x", "ok": True})

    def test_unknown_requirement_stays_unknown(self):
        raw = {
            "id": "test-record",
            "application": {"essay": {}, "fee": {"amount": "not a number"}},
            "eligibility": {"minimumGpa": 12},
        }
        facts = enrich_v4.normalize_facts(raw, self.record)
        self.assertEqual(facts["application"]["essay"], {"status": "unknown", "count": None})
        self.assertEqual(facts["application"]["fee"], {"status": "unknown", "amount": None})
        self.assertIsNone(facts["eligibility"]["minimumGpa"])

    def test_classification_rejects_unknown_and_unproven_negative_tags(self):
        facts = enrich_v4.normalize_facts({}, self.record)
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": "Applicants must submit an essay. Engineering students are eligible.",
            }]
        }
        raw = {
            "assignments": [
                {
                    "tag": "engineering",
                    "relationship": "eligible",
                    "evidence": "Engineering students are eligible.",
                    "sourceUrl": "https://example.com/scholarship",
                },
                {
                    "tag": "no-essay",
                    "relationship": "descriptive",
                    "evidence": "No essay.",
                    "sourceUrl": "https://example.com/scholarship",
                },
                {
                    "tag": "invented-tag",
                    "relationship": "eligible",
                    "evidence": "Anything",
                    "sourceUrl": "https://example.com/scholarship",
                },
            ]
        }
        classification, warnings = enrich_v4.normalize_classification(
            raw, facts, bundle, self.taxonomy
        )
        self.assertIn("engineering", classification["backendTags"])
        self.assertIn("stem", classification["backendTags"])
        self.assertNotIn("no-essay", classification["backendTags"])
        self.assertNotIn("invented-tag", classification["backendTags"])
        self.assertTrue(any("Rejected no-essay" in warning for warning in warnings))

    def test_evidence_ellipsis_matches_ordered_source_segments(self):
        text = (
            "Students who demonstrate strong academic achievement, leadership in school "
            "and the community, moral character, and rodeo skills are encouraged to apply."
        )
        self.assertTrue(
            enrich_v4.evidence_supported(
                "Students who demonstrate strong academic achievement... are encouraged to apply.",
                text,
            )
        )
        self.assertTrue(
            enrich_v4.evidence_supported("academic achievement... rodeo skills", text)
        )
        self.assertFalse(
            enrich_v4.evidence_supported("rodeo skills... academic achievement", text)
        )

    def test_typed_requirements_materialize_backend_tags(self):
        raw_facts = {
            "application": {
                "essay": {
                    "status": "required",
                    "count": 2,
                    "evidence": "Submit two essays.",
                    "sourceUrl": "record://test-record",
                },
                "transcript": {
                    "status": "required",
                    "evidence": "A transcript is required.",
                    "sourceUrl": "record://test-record",
                },
            },
            "award": {"renewable": True},
        }
        bundle = {
            "pages": [{
                "url": "record://test-record",
                "text": "Submit two essays. A transcript is required.",
            }]
        }
        facts = enrich_v4.normalize_facts(raw_facts, self.record, bundle)
        classification, _ = enrich_v4.normalize_classification(
            {"assignments": []}, facts, bundle, self.taxonomy
        )
        self.assertIn("essay-required", classification["backendTags"])
        self.assertIn("transcript-required", classification["backendTags"])
        self.assertIn("renewable", classification["backendTags"])

    def test_link_scoring_prioritizes_relevant_pages(self):
        useful = enrich_v4.link_score(
            "https://example.com/scholarship/eligibility",
            "Eligibility and requirements",
            self.record,
        )
        irrelevant = enrich_v4.link_score(
            "https://example.com/privacy",
            "Privacy policy",
            self.record,
        )
        self.assertGreaterEqual(useful, 6)
        self.assertLess(irrelevant, 0)
        generic = enrich_v4.link_score(
            "https://example.com/search/scholarships/results",
            "Engineering Scholarship Search",
            self.record,
        )
        self.assertLess(generic, 0)

    def test_normalize_facts_does_not_mutate_input(self):
        raw = {"award": {"minimum": 2000, "maximum": 1000}}
        original = copy.deepcopy(raw)
        facts = enrich_v4.normalize_facts(raw, self.record)
        self.assertEqual(raw, original)
        self.assertEqual(facts["award"]["minimum"], 1000)
        self.assertEqual(facts["award"]["maximum"], 2000)

    def test_past_cycle_cannot_be_marked_active(self):
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": "Applications for 2025 are open through July 31, 2025.",
            }]
        }
        raw = {
            "programStatus": "active",
            "statusReason": "The 2025 application is listed.",
            "statusEvidence": "Applications for 2025 are open through July 31, 2025.",
            "statusSourceUrl": "https://example.com/scholarship",
            "deadline": "2025-07-31",
        }
        facts = enrich_v4.normalize_facts(raw, self.record, bundle)
        self.assertEqual(facts["programStatus"], "uncertain")
        self.assertEqual(facts["deadlineType"], "fixed")

    def test_grade_aliases_are_canonicalized(self):
        facts = enrich_v4.normalize_facts(
            {
                "eligibility": {
                    "grades": [
                        "Community College Freshman",
                        "5th Year College Undergraduate",
                        "High School Senior",
                    ]
                }
            },
            self.record,
        )
        self.assertEqual(
            facts["eligibility"]["grades"],
            ["Community College Student", "Undergraduate", "High School Senior"],
        )

    def test_passed_deadline_does_not_mean_program_is_inactive(self):
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": "The application deadline was July 31, 2025.",
            }]
        }
        facts = enrich_v4.normalize_facts(
            {
                "programStatus": "inactive",
                "statusReason": "The deadline passed.",
                "statusEvidence": "The application deadline was July 31, 2025.",
                "statusSourceUrl": "https://example.com/scholarship",
                "deadline": "2025-07-31",
            },
            self.record,
            bundle,
        )
        self.assertEqual(facts["programStatus"], "uncertain")

    def test_requirement_tags_reconcile_unknown_typed_statuses(self):
        facts = enrich_v4.normalize_facts({}, self.record)
        classification = {
            "backendTags": ["no-essay", "transcript-required"],
            "frontendTags": ["no-essay"],
            "assignments": [],
        }
        enrich_v4.reconcile_application_requirements(facts, classification)
        self.assertEqual(facts["application"]["essay"]["status"], "not-required")
        self.assertEqual(facts["application"]["transcript"]["status"], "required")

    def test_parent_employment_does_not_assign_employee_applicant(self):
        facts = enrich_v4.normalize_facts({}, self.record)
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": "Applicants must have one or more parents employed by Example Company.",
            }]
        }
        classification, warnings = enrich_v4.normalize_classification(
            {
                "assignments": [{
                    "tag": "employee",
                    "relationship": "required",
                    "evidence": "Applicants must have one or more parents employed by Example Company.",
                    "sourceUrl": "https://example.com/scholarship",
                }]
            },
            facts,
            bundle,
            self.taxonomy,
        )
        self.assertNotIn("employee", classification["backendTags"])
        self.assertTrue(any("family employment" in warning for warning in warnings))

    def test_valid_fallback_assignment_removes_stale_rejection_warning(self):
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": (
                    "Applicants must have one or more parents employed by Example Company."
                ),
            }]
        }
        facts = enrich_v4.normalize_facts(
            {
                "eligibility": {
                    "exactCriteria": [
                        "Applicants must have one or more parents employed by Example Company."
                    ]
                }
            },
            self.record,
            bundle,
        )
        classification, warnings = enrich_v4.normalize_classification(
            {
                "assignments": [{
                    "tag": "employee-family",
                    "relationship": "required",
                    "evidence": "Parent employed by Example Company.",
                    "sourceUrl": "https://example.com/scholarship",
                }]
            },
            facts,
            bundle,
            self.taxonomy,
        )
        self.assertIn("employee-family", classification["backendTags"])
        self.assertFalse(any("Rejected employee-family" in warning for warning in warnings))

    def test_employee_before_family_relation_assigns_employee_family(self):
        criterion = (
            "Employee of Example Company, or their spouse or child"
        )
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "text": criterion,
            }]
        }
        facts = enrich_v4.normalize_facts(
            {"eligibility": {"exactCriteria": [criterion]}},
            self.record,
            bundle,
        )
        classification, warnings = enrich_v4.normalize_classification(
            {"assignments": []},
            facts,
            bundle,
            self.taxonomy,
        )
        self.assertIn("employee-family", classification["backendTags"])
        self.assertFalse(any("employee-family" in warning for warning in warnings))

    def test_current_output_ignores_enriched_field_changes(self):
        source = {
            **self.record,
            "sourceCheckedAt": "2026-06-01",
            "sourceUrls": ["https://example.com/scholarship"],
        }
        output = {
            "quality": {
                "pipelineVersion": enrich_v4.PIPELINE_VERSION,
                "promptVersion": enrich_v4.PROMPT_VERSION,
                "taxonomyVersion": self.taxonomy["version"],
                "sourceSignature": enrich_v4.source_signature(source),
            }
        }
        enriched = {
            **source,
            "description": "A model-refined description.",
            "deadline": "2027-01-01",
            "applicationUrl": "https://example.com/new-application",
        }
        self.assertTrue(
            enrich_v4.output_is_current(output, enriched, self.taxonomy["version"])
        )
        self.assertEqual(
            enrich_v4.crawl_hash(source),
            enrich_v4.crawl_hash(enriched),
        )

    def test_shard_selection_is_non_overlapping_and_complete(self):
        catalog = [{"id": f"id-{index:02d}"} for index in range(10)]
        shards = [
            enrich_v4.selected_records(catalog, 0, 0, set(), 3, index)
            for index in range(3)
        ]
        flattened = [record["id"] for shard in shards for record in shard]
        self.assertEqual(sorted(flattened), [record["id"] for record in catalog])
        self.assertEqual(len(flattened), len(set(flattened)))

    def test_gemini_keys_are_loaded_in_order_without_duplicates(self):
        env = {
            "GEMINI_API_KEY": "key-0",
            "GEMINI_API_KEY1": "key-1",
            "GEMINI_API_KEY2": "key-0",
            "GEMINI_API_KEY3": " ",
            "GEMINI_API_KEY8": "key-8",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(enrich_v4.gemini_api_keys(), ["key-0", "key-1", "key-8"])

    def test_gemma_client_rotates_keys(self):
        client = enrich_v4.GemmaClient(["a", "b", "c"], ["model"], 1, 0, 0)
        self.assertEqual([client.key_for_request()[0] for _ in range(5)], [0, 1, 2, 0, 1])

    def test_record_only_crawler_uses_imported_record_without_browser(self):
        async def bundle():
            async with enrich_v4.ScholarshipCrawler(1000, 2000, 1, 1000, record_only=True) as crawler:
                return await crawler.bundle(self.record)

        result = asyncio.run(bundle())
        self.assertEqual(result["sourceMode"], "record-fallback")
        self.assertEqual(result["pages"][0]["role"], "record-fallback")

    def test_prefill_outputs_are_upgradeable(self):
        self.assertTrue(enrich_v4.output_is_prefill({"quality": {"models": ["deterministic-prefill"]}}))
        self.assertFalse(enrich_v4.output_is_prefill({"quality": {"models": ["openrouter/free"]}}))

    def test_openrouter_client_uses_server_side_bearer_key_and_json_mode(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "model": "free/model",
            "choices": [{"message": {"content": '{"ok": true}'}}],
        }).encode()
        client = enrich_v4.GemmaClient(["secret"], ["openrouter/free"], 1, 0, 0, "openrouter")
        with patch.object(client, "wait_for_dns"), patch.object(enrich_v4, "urlopen", return_value=response), patch.object(enrich_v4, "Request") as request:
            result, model = client.generate("Return JSON")
        self.assertEqual((result, model), ({"ok": True}, "free/model"))
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer secret")
        body = json.loads(request.call_args.kwargs["data"])
        self.assertEqual(body["response_format"], {"type": "json_object"})

    def test_openrouter_upstream_rate_limit_falls_back_to_next_model(self):
        error = enrich_v4.HTTPError("https://openrouter.ai", 429, "rate limited", {}, BytesIO(b'{"metadata":{"provider_name":"Example"}}'))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "model": "second/free",
            "choices": [{"message": {"content": '{"ok": true}'}}],
        }).encode()
        client = enrich_v4.GemmaClient(["secret"], ["first/free", "second/free"], 1, 0, 0, "openrouter")
        with patch.object(client, "wait_for_dns"), patch.object(enrich_v4, "urlopen", side_effect=[error, response]):
            result, model = client.generate("Return JSON")
        self.assertEqual((result, model), ({"ok": True}, "second/free"))

    def test_openrouter_rate_limit_stops_the_resumable_run(self):
        error = enrich_v4.HTTPError("https://openrouter.ai", 429, "rate limited", {"Retry-After": "0"}, BytesIO(b'{"error":"limited"}'))
        client = enrich_v4.GemmaClient(["secret"], ["openrouter/free"], 1, 0, 0, "openrouter")
        with patch.object(client, "wait_for_dns"), patch.object(enrich_v4, "urlopen", side_effect=error):
            with self.assertRaises(enrich_v4.RateLimitError):
                client.generate("Return JSON")

    def test_batch_records_are_keyed_by_id(self):
        raw = {"records": [{"id": "a", "facts": {}, "classification": {}}]}
        self.assertEqual(list(enrich_v4.batch_records(raw)), ["a"])
        with self.assertRaises(ValueError):
            enrich_v4.batch_records({"records": {}})

    def test_combined_batch_prompt_contains_each_record_id(self):
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "role": "seed",
                "title": "Example",
                "text": "No essay required.",
            }]
        }
        prompt = enrich_v4.combined_batch_prompt(
            [
                ({**self.record, "id": "a"}, bundle),
                ({**self.record, "id": "b"}, bundle),
            ],
            self.taxonomy,
            3000,
        )
        self.assertIn('"id": "a"', prompt)
        self.assertIn('"id": "b"', prompt)
        self.assertIn("top-level key: records", prompt)
        self.assertIn("candidateTags", prompt)

    def test_candidate_tags_include_obvious_source_matches(self):
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "role": "seed",
                "title": "Example",
                "text": "Engineering students are eligible. No essay required.",
            }]
        }
        tags = enrich_v4.candidate_tag_ids(self.record, bundle, self.taxonomy)
        self.assertIn("engineering", tags)
        self.assertIn("stem", tags)
        self.assertIn("no-essay", tags)

    def test_concise_source_prefers_relevant_lines_over_nav_filler(self):
        filler = "\n".join(f"Navigation link {index}" for index in range(80))
        bundle = {
            "pages": [{
                "url": "https://example.com/scholarship",
                "role": "seed",
                "title": "Example Engineering Scholarship",
                "text": (
                    f"{filler}\n"
                    "Applicants must be engineering majors with a 3.0 GPA.\n"
                    "The application deadline is March 15, 2027.\n"
                    "The award amount is $2,500."
                ),
            }]
        }
        concise = enrich_v4.concise_source_document(bundle, 700)
        self.assertIn("engineering majors", concise)
        self.assertIn("deadline is March 15, 2027", concise)
        self.assertIn("$2,500", concise)
        self.assertNotIn("Navigation link 79", concise)


if __name__ == "__main__":
    unittest.main()
